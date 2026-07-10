const statusBadge = document.getElementById('status');
const bannerEstado = document.getElementById('banner-estado');
const cajaEventos = document.getElementById('caja-eventos');
const ctx = canvas.getContext('2d');
const videoElement = document.getElementById('webcam');

// Nuevos botones de silenciar
const btnSilenciarOptico = document.getElementById('btn-silenciar-optico');
const btnSilenciarAcustico = document.getElementById('btn-silenciar-acustico');

let model = null;
let registrosPersonas = [];
let modoInfrarrojoActivo = false;

// Variables de estado para los silenciadores (inician activos por defecto)
let detectorOpticoActivo = true;
let detectorAcusticoActivo = true;

// Variables globales para la Analítica de Audio y Grabación
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;
let bufferCircularAudio = []; // Almacena los fragmentos de audio reales
let tiempoUltimaAlertaAcustica = 0;

// Historial dinámico para el detector de transitorios (Impactos rápidos)
let gravesPrevios = 0;

// =================================================================
// RECALIBRACIÓN EN TIEMPO REAL ANTI-FALSOS POSITIVOS Y ALTA VELOCIDAD
// =================================================================
let historialCajas = {}; 
const CONTEXTO_FOTOGRAMAS_MINIMO = 3;    // Captura ráfagas rápidas/corredores bajando la espera inicial
const UMBRAL_MOVIMIENTO_CAJA = 1.8;      // Sensibilidad micrométrica para descartar objetos quietos
const UMBRAL_DESPLAZAMIENTO_RAPIDO = 25; // Si se desplaza más de 25px por frame, es un intruso rápido (Bypass)

// Constantes de calibración del sistema
const TIEMPO_ESPERA_REPETICION = 2 * 60 * 1000;  // 2 minutos entre logs del mismo intruso
const TOLERANCIA_PIXELES = 120;                  // Rango de tracking de movimiento
const TIEMPO_EXPIRACION_TRACKING = 10 * 1000;    // Tiempo para olvidar tracking visual
const INTERVALO_ALERTA_AUDIO = 8000;             // Cooldown entre alertas acústicas (8 seg)

// Punto de entrada de la aplicación
async function inicializar() {
    await encenderCamara();
    window.addEventListener('resize', ajustarDimensionesCanvas);
    
    // Configurar controladores de eventos para los nuevos botones de silenciar
    configurarBotonesSilencio();
    
    // Carga paralela de modelos
    bannerEstado.innerText = "Inicializando sensores ópticos y acústicos de seguridad...";
    model = await cocoSsd.load();
    
    // Inicializar el sistema de audición computacional
    await inicializarAnaliticaAudio();
    
    statusBadge.innerText = "ONLINE";
    statusBadge.className = "status-badge ready";
    bannerEstado.innerText = "Filtro horario activo: Analizando salón cerrado y espectro acústico.";
    
    analizarVideo();
}

// Configuración visual y funcional de los silenciadores
function configurarBotonesSilencio() {
    if (btnSilenciarOptico) {
        btnSilenciarOptico.addEventListener('click', () => {
            detectorOpticoActivo = !detectorOpticoActivo;
            if (detectorOpticoActivo) {
                btnSilenciarOptico.style.background = "#22c55e";
                btnSilenciarOptico.innerText = "🟢 DETECTOR VISUAL ACTIVO";
            } else {
                btnSilenciarOptico.style.background = "#64748b";
                btnSilenciarOptico.innerText = "🔇 DETECTOR VISUAL SILENCIADO";
                // Limpiar el canvas inmediatamente para quitar recuadros viejos
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        });
    }

    if (btnSilenciarAcustico) {
        btnSilenciarAcustico.addEventListener('click', () => {
            detectorAcusticoActivo = !detectorAcusticoActivo;
            if (detectorAcusticoActivo) {
                btnSilenciarAcustico.style.background = "#f97316";
                btnSilenciarAcustico.innerText = "🟢 DETECTOR ACÚSTICO ACTIVO";
            } else {
                btnSilenciarAcustico.style.background = "#64748b";
                btnSilenciarAcustico.innerText = "🔇 DETECTOR ACÚSTICO SILENCIADO";
            }
        });
    }
}

// Inicialización del Micrófono y Analizador de Espectrogramas
async function inicializarAnaliticaAudio() {
    try {
        const streamAudio = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Configuración del motor de Audio Web nativo
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const fuente = audioCtx.createMediaStreamSource(streamAudio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512; // Resolución de frecuencias idónea para análisis en tiempo real
        fuente.connect(analyser);

        // Intentar usar un codec ampliamente compatible para grabación en navegadores móviles
        let opcionesCodec = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(opcionesCodec.mimeType)) {
            opcionesCodec = { mimeType: 'audio/webm' };
        }

        // Grabador continuo para los clips de evidencia
        mediaRecorder = new MediaRecorder(streamAudio, opcionesCodec);
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                bufferCircularAudio.push(e.data);
                // Mantenemos aproximadamente los últimos 8-10 fragmentos de 1 segundo
                if (bufferCircularAudio.length > 8) {
                    bufferCircularAudio.shift(); 
                }
            }
        };

        // Solicitar fragmentos de audio constantes cada 1 segundo para mantener el buffer actualizado
        setInterval(() => {
            if (mediaRecorder.state === "recording") {
                mediaRecorder.requestData();
            }
        }, 1000);

        mediaRecorder.start();
        procesarEspectroSonoro();
        
    } catch (error) {
        console.warn("No se pudo acceder al micrófono para la analítica acústica:", error);
    }
}

// Algoritmo de reconocimiento de firmas acústicas optimizado anti-falsos positivos
function procesarEspectroSonoro() {
    if (!analyser) return;

    const bufferLongitud = analyser.frequencyBinCount;
    const datosFrecuencia = new Uint8Array(bufferLongitud);
    
    let contadorTaladro = 0;
    let contadorAmoladora = 0;

    const bucleAudio = () => {
        analyser.getByteFrequencyData(datosFrecuencia);
        const tiempoActual = Date.now();

        // Inicializar acumuladores de energía por bandas de interés
        let graves = 0;  // subsónicos de golpes de maza
        let medios = 0;  // rango de la voz humana y taladros
        let agudos = 0;  // amoladoras, sierras y chillidos

        for (let i = 0; i < bufferLongitud; i++) {
            if (i < 5) {
                graves += datosFrecuencia[i];
            } else if (i >= 5 && i < 35) {
                medios += datosFrecuencia[i];
            } else if (i >= 35) {
                agudos += datosFrecuencia[i];
            }
        }

        // --- OPTIMIZACIÓN SILENCIO: Ignorar lógica de análisis si el detector acústico está apagado ---
        if (detectorAcusticoActivo) {
            
            // 1. DETECTOR DE IMPACTO SECO (MAZA/GOLPES DE BOQUETE)
            let deltaGraves = graves - gravesPrevios;
            gravesPrevios = graves;

            if (deltaGraves > 380 && graves > 550 && medios < 1500) {
                if (tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) {
                    tiempoUltimaAlertaAcustica = tiempoActual;
                    registrarEventoAcustico("GOLPES CONTINUOS / INTENTO DE BOQUETE");
                }
            }

            // 2. DETECTOR DE HERRAMIENTA ROTATIVA (AMOLADORA)
            let ratioAmoladora = agudos / (medios + 1);

            if (agudos > 1200 && ratioAmoladora > 0.8) {
                contadorAmoladora++;
                if (contadorAmoladora > 50 && tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) {
                    tiempoUltimaAlertaAcustica = tiempoActual;
                    registrarEventoAcustico("HERRAMIENTA ROTATIVA DE CORTE (AMOLADORA)");
                    contadorAmoladora = 0;
                }
            } else {
                contadorAmoladora = Math.max(0, contadorAmoladora - 1);
            }

            // 3. DETECTOR DE HERRAMIENTA DE PERCUSIÓN (TALADRO)
            if (medios > 2800 && agudos < 1000) {
                contadorTaladro++;
                if (contadorTaladro > 50 && tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) {
                    tiempoUltimaAlertaAcustica = tiempoActual;
                    registrarEventoAcustico("HERRAMIENTA DE PERCUSIÓN (TALADRO/ROTOMARTILLO)");
                    contadorTaladro = 0;
                }
            } else {
                contadorTaladro = Math.max(0, contadorTaladro - 1);
            }

        } else {
            // Aseguramos mantener actualizado el estado previo de graves aunque esté silenciado
            gravesPrevios = graves;
            contadorAmoladora = 0;
            contadorTaladro = 0;
        }

        requestAnimationFrame(bucleAudio);
    };

    bucleAudio();
}

// Alternancia dinámica del Filtro Infrarrojo Digital
function alternarInfrarrojo() {
    const boton = document.getElementById('btn-infrarrojo');
    modoInfrarrojoActivo = !modoInfrarrojoActivo;
    
    if (modoInfrarrojoActivo) {
        videoElement.classList.add('filtro-nocturno');
        boton.classList.add('activo');
        boton.innerText = "❌ DESACTIVAR FILTRO INFRARROJO";
    } else {
        videoElement.classList.remove('filtro-nocturno');
        boton.classList.remove('activo');
        boton.innerText = "🌙 ACTIVAR FILTRO INFRARROJO";
    }
}

// Bucle de inferencia visual y tracking continuo optimizado
async function analizarVideo() {
    if (!model) return;

    if (!detectorOpticoActivo) {
        requestAnimationFrame(analizarVideo);
        return;
    }

    const predicciones = await model.detect(videoElement);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const tiempoActual = Date.now();

    // IDs activos en este fotograma para saber cuáles limpiar al final
    let idsVistosEsteFrame = new Set();

    predicciones.forEach(objeto => {
        // Mantenemos la confianza base en 0.65 para no perder siluetas reales y lejanas
        if (objeto.class === 'person' && objeto.score > 0.65) {
            const [x, y, ancho, alto] = objeto.bbox;

            let idAsignado = null;
            let esMismaPersona = false;

            // 1. ASIGNACIÓN DE ID POR PROXIMIDAD (TRACKING)
            for (let i = 0; i < registrosPersonas.length; i++) {
                let r = registrosPersonas[i];
                if (Math.abs(r.x - x) < TOLERANCIA_PIXELES && Math.abs(r.y - y) < TOLERANCIA_PIXELES) {
                    esMismaPersona = true;
                    r.x = x; 
                    r.y = y;
                    idAsignado = i; // Usamos el índice como ID único persistente
                    break;
                }
            }

            if (!esMismaPersona) {
                registrosPersonas.push({ x, y, ultimoRegistro: tiempoActual });
                idAsignado = registrosPersonas.length - 1;
            }

            idsVistosEsteFrame.add(idAsignado);

            // 2. INICIALIZAR O ACTUALIZAR EL HISTORIAL DE PERSISTENCIA Y ANÁLISIS DINÁMICO
            if (!historialCajas[idAsignado]) {
                historialCajas[idAsignado] = {
                    contadorFrames: 1,
                    ultimoX: x,
                    ultimoY: y,
                    acumuladorMovimiento: 0,
                    alertaConfirmada: false,
                    esIntrusoRapido: false
                };
            } else {
                let datosCaja = historialCajas[idAsignado];
                datosCaja.contadorFrames++;

                // Calcular variaciones en frames consecutivos
                let deltaX = Math.abs(datosCaja.ultimoX - x);
                let deltaY = Math.abs(datosCaja.ultimoY - y);
                let movimientoFrame = deltaX + deltaY;

                datosCaja.acumuladorMovimiento += movimientoFrame;

                // FILTRO DE VELOCIDAD: Si el objeto saltó muchos píxeles en un solo cuadro, es un intruso rápido
                if (movimientoFrame > UMBRAL_DESPLAZAMIENTO_RAPIDO) {
                    datosCaja.esIntrusoRapido = true;
                }

                // Actualizar coordenadas previas para el siguiente frame
                datosCaja.ultimoX = x;
                datosCaja.ultimoY = y;
            }

            let analisisCaja = historialCajas[idAsignado];

            // 3. VALIDACIÓN ELÁSTICA: ¿Es un intruso veloz o superó el filtro de micro-movimiento estático?
            if (analisisCaja.esIntrusoRapido || 
               (analisisCaja.contadorFrames >= CONTEXTO_FOTOGRAMAS_MINIMO && analisisCaja.acumuladorMovimiento > UMBRAL_MOVIMIENTO_CAJA)) {
                
                // Renderizar recuadro verde de alerta activa
                ctx.strokeStyle = "#22c55e"; 
                ctx.lineWidth = 3;
                ctx.strokeRect(x, y, ancho, alto);

                // Gestión de envío de alertas controlada por tiempo
                let r = registrosPersonas[idAsignado];
                if (!analisisCaja.alertaConfirmada || (tiempoActual - r.ultimoRegistro > TIEMPO_ESPERA_REPETICION)) {
                    r.ultimoRegistro = tiempoActual;
                    analisisCaja.alertaConfirmada = true;
                    registrarEventoInterno(objeto);
                }
            } else {
                // Renderizado preventivo: cuadro muy tenue mientras el cerebro evalúa si se mueve o es una silla
                ctx.strokeStyle = "rgba(34, 197, 94, 0.15)";
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, ancho, alto);
            }
        }
    });

    // Limpieza de memoria del historial de cajas de objetos que desaparecieron
    for (let id in historialCajas) {
        if (!idsVistosEsteFrame.has(parseInt(id))) {
            delete historialCajas[id];
        }
    }

    registrosPersonas = registrosPersonas.filter(r => tiempoActual - r.ultimoRegistro < TIEMPO_EXPIRACION_TRACKING);
    requestAnimationFrame(analizarVideo);
}

// REGISTRO 1: Crea las tarjetas ópticas de intrusión (Fotos)
function registrarEventoInterno(objetoIA) {
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const canvasFoto = document.createElement('canvas');
    canvasFoto.width = videoElement.videoWidth;
    canvasFoto.height = videoElement.videoHeight;
    const ctxFoto = canvasFoto.getContext('2d');

    if (modoInfrarrojoActivo) {
        ctxFoto.filter = 'grayscale(100%) brightness(280%) contrast(80%)';
    } else {
        ctxFoto.filter = 'none';
    }
    
    ctxFoto.drawImage(videoElement, 0, 0);

    const tarjeta = document.createElement('div');
    tarjeta.className = 'registro-card';
    tarjeta.innerHTML = `
        <img src="${canvasFoto.toDataURL('image/jpeg')}" alt="Evidencia" onclick="abrirVisor(this.src)">
        <div class="registro-info">
            <div class="alerta-texto">⚠️ POSIBLE INTRUSO DETECTADO</div>
            <div class="meta-line">Cámara: <span>Celular Trasera #1</span></div>
            <div class="meta-line">Fiabilidad: <span>${Math.round(objetoIA.score * 100)}%</span></div>
            <div class="meta-line">Registro: <span>${hora} hs</span></div>
        </div>
    `;
    cajaEventos.insertBefore(tarjeta, cajaEventos.firstChild);
}

// REGISTRO 2: Crea las tarjetas acústicas con el nuevo formato y carga de audio garantizada
function registrarEventoAcustico(herramientaDetectada) {
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Hacemos una copia exacta y limpia del buffer circular actual
    const chunksCopia = [...bufferCircularAudio];
    
    // Validamos que haya datos reales antes de armar el reproductor
    if (chunksCopia.length === 0) return;

    const audioBlob = new Blob(chunksCopia, { type: 'audio/webm;codecs=opus' });
    const audioUrl = URL.createObjectURL(audioBlob);

    const tarjeta = document.createElement('div');
    tarjeta.className = 'registro-card';
    tarjeta.style.borderLeft = "4px solid #f97316"; // Borde táctico naranja
    
    tarjeta.innerHTML = `
        <div style="font-size: 1.8rem; display: flex; align-items: center; justify-content: center; background: rgba(249, 115, 22, 0.1); border-radius: 6px; padding: 10px; min-width: 80px; height: 80px; border: 1px solid rgba(249, 115, 22, 0.2);">
            🔊
        </div>
        <div class="registro-info" style="width: 100%;">
            <div class="alerta-texto" style="color: #f97316;">🚨 AMENAZA ACÚSTICA DETECTADA</div>
            <div class="meta-line">Origen: <span>Micrófono de Cabina</span></div>
            <div class="meta-line">Evento: <span style="color: #f97316;">Posible sonido compatible con ${herramientaDetectada}</span></div>
            <div class="meta-line">Registro: <span>${hora} hs</span></div>
            
            <audio controls preload="auto" style="width: 100%; height: 28px; margin-top: 6px; outline: none;">
                <source src="${audioUrl}" type="audio/webm">
                Tu navegador no soporta reproducción de audio.
            </audio>
        </div>
    `;

    // Insertar la tarjeta en la interfaz
    cajaEventos.insertBefore(tarjeta, cajaEventos.firstChild);

    // Forzar al elemento HTML5 a inicializar y leer el búfer cargado
    const reproductorInstanciado = tarjeta.querySelector('audio');
    if (reproductorInstanciado) {
        reproductorInstanciado.load();
    }
}

// Arrancar la app automáticamente al cargar la ventana
window.onload = inicializar;
