const statusBadge = document.getElementById('status');
const bannerEstado = document.getElementById('banner-estado');
const cajaEventos = document.getElementById('caja-eventos');
const ctx = canvas.getContext('2d');
const videoElement = document.getElementById('webcam'); // CORRECCIÓN: Agregada la referencia al video

let model = null;
let registrosPersonas = [];
let modoInfrarrojoActivo = false; // Estado del filtro nocturno

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

// CORRECCIÓN: Lógica corregida para aplicar el filtro y alternar los textos del botón
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

// Bucle de inferencia y tracking continuo
async function analizarVideo() {
    if (!model) return;

    const predicciones = await model.detect(videoElement); // Usar videoElement
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const tiempoActual = Date.now();

    predicciones.forEach(objeto => {
        if (objeto.class === 'person' && objeto.score > 0.65) {
            const [x, y, ancho, alto] = objeto.bbox;

            // Dibujar feedback visual en pantalla
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

// Registra la captura en el panel lateral del operador
function registrarEventoInterno(objetoIA) {
    const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Captura estática del frame del video
    const canvasFoto = document.createElement('canvas');
    canvasFoto.width = videoElement.videoWidth; // Usar videoElement
    canvasFoto.height = videoElement.videoHeight; // Usar videoElement
    const ctxFoto = canvasFoto.getContext('2d');

    // Aplicar filtro a la foto de evidencia SOLO si el modo infrarrojo está activo
    if (modoInfrarrojoActivo) {
        ctxFoto.filter = 'grayscale(100%) contrast(140%) brightness(110%)';
    } else {
        ctxFoto.filter = 'none';
    }
    
    ctxFoto.drawImage(videoElement, 0, 0); // Usar videoElement

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

// Arrancar la app automáticamente al cargar la ventana
window.onload = inicializar;
