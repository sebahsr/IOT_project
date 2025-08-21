require('dotenv').config();
const mqtt = require('mqtt');

const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const client = mqtt.connect(url);

client.on('connect', () => {
  console.log('👀 Watching: shega/alerts');
  client.subscribe('shega/alerts');
});

client.on('message', (topic, buf) => {
  console.log('ALERT', buf.toString());
});
