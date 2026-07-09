const statusBadge = document.getElementById('status');
const bannerEstado = document.getElementById('banner-estado');
const cajaEventos = document.getElementById('caja-eventos');
const ctx = canvas.getContext('2d');

let model = null;
let registrosPersonas = [];

// Constantes de calibración del sistema
const TIEMPO_ESPERA_REPETICION = 2 * 60 * 1000; // 2 minutos entre logs del mismo intruso
const TOLERANCIA_PIXELES = 120;                 // Rango de tracking de movimiento
const TIEMPO_EXPIRACION_TRACKING = 10 * 1000;   // Tiempo para olvidar a alguien que salió de escena

// Punto de entrada de la aplicación
async function inicializar() {
    await encenderCamara();
    window.addEventListener('resize', ajustarDimensionesCanvas);
    
    // Carga del modelo TensorFlow
    model = await cocoSsd.load();
    
    statusBadge.innerText = "ONLINE";
    statusBadge.className = "status-badge ready";
    bannerEstado.innerText = "Filtro horario activo: Analizando salón cerrado.";
    
    analizarVideo();
}

// Bucle de inferencia y tracking continuo
async function analizarVideo() {
    if (!model) return;

    const predicciones = await model.detect(video);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const tiempoActual = Date.now();

    predicciones.forEach(objeto => {
        // Umbral de fiabilidad del 65% para evitar falsos positivos nocturnos
        if (objeto.class === 'person' && objeto.score > 0.65) {
            const [x, y, ancho, alto] = objeto.bbox;

            // Dibujar feedback visual en pantalla (Caja táctica verde)
            ctx.strokeStyle = "#22c55e";
            ctx.lineWidth = 3;
            ctx.strokeRect(x, y, ancho, alto);

            let esMismaPersona = false;

            // Evaluar contra el registro de personas activas
            for (let i = 0; i < registrosPersonas.length; i++) {
                let r = registrosPersonas[i];
                if (Math.abs(r.x - x) < TOLERANCIA_PIXELES && Math.abs(r.y - y) < TOLERANCIA_PIXELES) {
                    esMismaPersona = true;
                    r.x = x; // Actualizar coordenadas en tiempo real
                    r.y = y;

                    // Re-alertar si se cumple el intervalo de tiempo configurado
                    if (tiempoActual - r.ultimoRegistro > TIEMPO_ESPERA_REPETICION) {
                        r.ultimoRegistro = tiempoActual;
                        registrarEventoInterno(objeto);
                    }
                    break;
                }
            }

            // Registrar nuevo intruso si no coincide con ninguno anterior
            if (!esMismaPersona) {
                registrosPersonas.push({ x, y, ultimoRegistro: tiempoActual });
                registrarEventoInterno(objeto);
            }
        }
    });

    // Limpieza de memoria (Elimina personas ausentes por más de 10 segundos)
    registrosPersonas = registrosPersonas.filter(r => tiempoActual - r.ultimoRegistro < TIEMPO_EXPIRACION_TRACKING);
    
    requestAnimationFrame(analizarVideo);
}

// Registra la captura analítica en el panel de auditoría del operador
function registrarEventoInterno(objetoIA) {
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Captura estática del frame del video
    const canvasFoto = document.createElement('canvas');
    canvasFoto.width = video.videoWidth;
    canvasFoto.height = video.videoHeight;
    const ctxFoto = canvasFoto.getContext('2d');
    
    // FILTRO ANALÍTICO PRE-PROCESADO: Aplica un filtro digital a la imagen guardada 
    // para emular el procesamiento infrarrojo que limpia el ruido en segundo plano
    ctxFoto.filter = 'grayscale(100%) contrast(140%) brightness(110%)';
    ctxFoto.drawImage(video, 0, 0);

    // Creamos la nueva estructura del Ticket de Eventos
    const tarjeta = document.createElement('div');
    tarjeta.className = 'registro-card';
    tarjeta.innerHTML = `
        <img src="${canvasFoto.toDataURL('image/jpeg')}" alt="Evidencia Analítica" onclick="abrirVisor(this.src)">
        <div class="registro-info">
            <div class="alerta-texto">🚨 CRÍTICO: INTRUSO</div>
            <div class="meta-grid">
                <div class="meta-line">ORIGEN:</div>
                <div class="meta-line"><span>CAM_01_RESTRIC</span></div>
                
                <div class="meta-line">FIABILIDAD:</div>
                <div class="meta-line"><span>${Math.round(objetoIA.score * 100)}%</span></div>
                
                <div class="meta-line">REGISTRO:</div>
                <div class="meta-line"><span>${hora} HS</span></div>
            </div>
        </div>
    `;
    cajaEventos.insertBefore(tarjeta, cajaEventos.firstChild);
}

// Arrancar la app automáticamente al cargar la ventana
window.onload = inicializar;
