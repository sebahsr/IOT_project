require('dotenv').config();
const mqtt = require('mqtt');

const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const client = mqtt.connect(url);

client.on('connect', () => {
  console.log('👀 Watching: shega/+/control');
  client.subscribe('shega/+/control');
});

client.on('message', (topic, buf) => {
  console.log('CTRL', topic, buf.toString());
});
