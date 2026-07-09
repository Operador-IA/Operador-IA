const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const visorModal = document.getElementById('visor-modal');
const imgGrande = document.getElementById('img-grande');

// Enciende la cámara trasera (o fallback)
async function encenderCamara() {
    const opciones = { video: { facingMode: "environment" }, audio: false };
    try {
        video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" } }, audio: false });
    } catch {
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
