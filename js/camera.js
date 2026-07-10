const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const visorModal = document.getElementById('visor-modal');
const imgGrande = document.getElementById('img-grande');

// CORRECCIÓN: Enciende la cámara trasera y fuerza la solicitud del micrófono simultáneamente
async function encenderCamara() {
    // Configuración base con audio habilitado obligatoriamente
    const opciones = { 
        video: { facingMode: "environment" }, 
        audio: true // MODIFICACIÓN: Habilita el micrófono en el fallback
    };
    
    try {
        // Intenta arrancar con la cámara trasera principal exacta del celular y el micrófono
        video.srcObject = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: { exact: "environment" } }, 
            audio: true // MODIFICACIÓN: Habilita el micrófono en la solicitud principal
        });
    } catch {
        // Si falla (por ejemplo, en una PC sin cámara trasera), usa la cámara por defecto y el micrófono
        video.srcObject = await navigator.mediaDevices.getUserMedia(opciones);
    }
    
    return new Promise(resolve => {
        video.onloadedmetadata = () => {
            ajustarDimensionesCanvas();
            resolve();
        };
    });
}

// Mantiene el canvas alineado con el video real
function ajustarDimensionesCanvas() {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
}

// Controladores del visor de Zoom interactivo
function abrirVisor(url) {
    imgGrande.src = url;
    visorModal.style.display = 'flex';
}

function cerrarVisor() {
    visorModal.style.display = 'none';
    imgGrande.src = '';
}
