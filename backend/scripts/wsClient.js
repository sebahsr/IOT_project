require('dotenv').config();
const { io } = require('socket.io-client');

const URL = process.env.WS_URL || 'http://localhost:3000';
const TOKEN = process.env.SHEGA_TOKEN; // set this before running

if (!TOKEN) {
  console.error('Set SHEGA_TOKEN env var to a valid JWT');
  process.exit(1);
}

const socket = io(URL, { auth: { token: TOKEN } });

socket.on('connect', () => console.log('WS connected', socket.id));
socket.on('ready', (msg) => console.log('ready', msg));
socket.on('telemetry', (msg) => console.log('telemetry', msg));
socket.on('alert', (msg) => console.log('alert', msg));
socket.on('command', (msg) => console.log('command', msg));
socket.on('connect_error', (err) => console.error('connect_error', err.message));
