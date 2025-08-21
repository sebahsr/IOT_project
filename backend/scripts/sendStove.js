require('dotenv').config();
const mqtt = require('mqtt');

const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const client = mqtt.connect(url);

client.on('connect', () => {
  console.log('MQTT connected for sendStove');
  const msg = {
    homeId: 'HOME123',
    deviceId: 'STOVE-001',
    stream: 'STOVE',
    payload: {
      stoveTemp: 120 + Math.random() * 15,
      buzzer: 0,
      fan: 1
    },
    ts: new Date().toISOString()
  };
  client.publish('shega/stovenode/data', JSON.stringify(msg), {}, () => {
    console.log('Published STOVE telemetry:', msg);
    client.end();
  });
});
