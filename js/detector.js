const statusBadge = document.getElementById('status');
const bannerEstado = document.getElementById('banner-estado');
const cajaEventos = document.getElementById('caja-eventos');
const ctx = canvas.getContext('2d');
const videoElement = document.getElementById('webcam');

let model = null;
let registrosPersonas = [];
let modoInfrarrojoActivo = false;

// Variables globales para la Analítica de Audio y Grabación
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;
let chunksAudio = [];
let bufferCircularAudio = []; // Guarda los últimos segundos en memoria
let tiempoUltimaAlertaAcustica = 0;

// Constantes de calibración del sistema
const TIEMPO_ESPERA_REPETICION = 2 * 60 * 1000;  // 2 minutos entre logs del mismo intruso/ruido
const TOLERANCIA_PIXELES = 120;                  // Rango de tracking de movimiento
const TIEMPO_EXPIRACION_TRACKING = 10 * 1000;    // Tiempo para olvidar tracking visual
const INTERVALO_ALERTA_AUDIO = 8000;             // Cooldown para no saturar con alertas de ruido

// Punto de entrada de la aplicación
async function inicializar() {
    await encenderCamara();
    window.addEventListener('resize', ajustarDimensionesCanvas);
    
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

// Inicialización del Micrófono y Analizador de Espectrogramas
async function inicializarAnaliticaAudio() {
    try {
        const streamAudio = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Configuración del motor de Audio Web nativo
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const fuente = audioCtx.createMediaStreamSource(streamAudio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512; // Resolución de frecuencias
        fuente.connect(analyser);

        // Grabador continuo para los clips de evidencia (Buffer de memoria circular)
        mediaRecorder = new MediaRecorder(streamAudio, { mimeType: 'audio/webm' });
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                bufferCircularAudio.push(e.data);
                // Mantener solo los últimos ~6 segundos de audio en memoria (6 fragmentos de 1s)
                if (bufferCircularAudio.length > 6) {
                    bufferCircularAudio.shift();
                }
            }
        };

        // Solicitar fragmentos de audio cada 1 segundo
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

// Algoritmo de reconocimiento de Huellas Dactilares Acústicas
function procesarEspectroSonoro() {
    if (!analyser) return;

    const bufferLongitud = analyser.frequencyBinCount;
    const datosFrecuencia = new Uint8Array(bufferLongitud);
    
    let contadorTaladro = 0;
    let contadorAmoladora = 0;

    const bucleAudio = () => {
        analyser.getByteFrequencyData(datosFrecuencia);
        const tiempoActual = Date.now();

        // Dividimos el espectro en sub-bandas analíticas
        let graves = 0;  // 0 a 80 Hz aprox (Maza, golpes estructurales)
        let medios = 0;  // 200 a 1000 Hz aprox (Taladros, rotomartillos)
        let agudos = 0;  // 2000 a 4000 Hz aprox (Amoladoras, sierras, chillidos)

        for (let i = 0; i < bufferLongitud; i++) {
            if (i < 5) graves += datosFrecuencia[i];
            else if (i >= 5 && i < 40) medios += datosFrecuencia[i];
            else if (i >= 40) agudos += datosFrecuencia[i];
        }

        // 1. Detección de Impacto Estructural (Maza / Boquete)
        // Busca un pico de energía brutal y repentino en los graves profundos
        if (graves > 850 && tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) {
            tiempoUltimaAlertaAcustica = tiempoActual;
            registrarEventoAcustico("GOLPES CONTINUOS / INTENTO DE BOQUETE");
        }

        // 2. Detección de Herramienta de Percusión (Taladro / Rotomartillo)
        // Busca energía media sostenida de alta intensidad
        if (medios > 3200) {
            contadorTaladro++;
            if (contadorTaladro > 75 && tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) { // ~1.5 segundos sostenido
                tiempoUltimaAlertaAcustica = tiempoActual;
                registrarEventoAcustico("HERRAMIENTA DE PERCUSIÓN (TALADRO/ROTOMARTILLO)");
                contadorTaladro = 0;
            }
        } else {
            contadorTaladro = Math.max(0, contadorTaladro - 1);
        }

        // 3. Detección de Herramienta Rotativa (Amoladora / Sierra)
        // Busca frecuencias agudas extremas y constantes
        if (agudos > 1500) {
            contadorAmoladora++;
            if (contadorAmoladora > 75 && tiempoActual - tiempoUltimaAlertaAcustica > INTERVALO_ALERTA_AUDIO) {
                tiempoUltimaAlertaAcustica = tiempoActual;
                registrarEventoAcustico("HERRAMIENTA ROTATIVA DE CORTE (AMOLADORA)");
                contadorAmoladora = 0;
            }
        } else {
            contadorAmoladora = Math.max(0, contadorAmoladora - 1);
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

// Bucle de inferencia visual y tracking continuo
async function analizarVideo() {
    if (!model) return;

    const predicciones = await model.detect(videoElement);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const tiempoActual = Date.now();

    predicciones.forEach(objeto => {
        if (objeto.class === 'person' && objeto.score > 0.65) {
            const [x, y, ancho, alto] = objeto.bbox;

            ctx.strokeStyle = "#22c55e";
            ctx.lineWidth = 3;
            ctx.strokeRect(x, y, ancho, alto);

            let esMismaPersona = false;

            for (let i = 0; i < registrosPersonas.length; i++) {
                let r = registrosPersonas[i];
                if (Math.abs(r.x - x) < TOLERANCIA_PIXELES && Math.abs(r.y - y) < TOLERANCIA_PIXELES) {
                    esMismaPersona = true;
                    r.x = x; 
                    r.y = y;

                    if (tiempoActual - r.ultimoRegistro > TIEMPO_ESPERA_REPETICION) {
                        r.ultimoRegistro = tiempoActual;
                        registrarEventoInterno(objeto);
                    }
                    break;
                }
            }

            if (!esMismaPersona) {
                registrosPersonas.push({ x, y, ultimoRegistro: tiempoActual });
                registrarEventoInterno(objeto);
            }
        }
    });

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
        // Nueva configuración de amplificación de luz residual (Más brillo, menos contraste)
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

// REGISTRO 2: NUEVO - Crea las tarjetas acústicas con reproductor de audio integrado
function registrarEventoAcustico(herramientaDetectada) {
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Consolidar los fragmentos de memoria circular para generar el clip de audio físico
    const audioBlob = new Blob(bufferCircularAudio, { type: 'audio/webm' });
    const audioUrl = URL.createObjectURL(audioBlob);

    const tarjeta = document.createElement('div');
    tarjeta.className = 'registro-card';
    // Estilo en línea táctico para diferenciarlo visualmente (Borde naranja de advertencia crítica acústica)
    tarjeta.style.borderLeft = "4px solid #f97316"; 
    
    tarjeta.innerHTML = `
        <div style="font-size: 1.8rem; display: flex; align-items: center; justify-content: center; background: rgba(249, 115, 22, 0.1); border-radius: 6px; padding: 10px; min-width: 80px; height: 80px; border: 1px solid rgba(249, 115, 22, 0.2);">
            🔊
        </div>
        <div class="registro-info" style="width: 100%;">
            <div class="alerta-texto" style="color: #f97316;">🚨 AMENAZA ACÚSTICA CRÍTICA</div>
            <div class="meta-line">Origen: <span>Micrófono de Cabina</span></div>
            <div class="meta-line">Evento: <span style="color: #f97316;">Posible sonido compatible con ${herramientaDetectada}</span></div>
            <div class="meta-line">Registro: <span>${hora} hs</span></div>
            
            <audio controls style="width: 100%; height: 28px; margin-top: 6px; outline: none;">
                <source src="${audioUrl}" type="audio/webm">
                Tu navegador no soporta reproducción de audio.
            </audio>
        </div>
    `;
    cajaEventos.insertBefore(tarjeta, cajaEventos.firstChild);
}

// Arrancar la app automáticamente al cargar la ventana
window.onload = inicializar;
