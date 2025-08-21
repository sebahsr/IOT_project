require('dotenv').config();
const mqtt = require('mqtt');

const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const client = mqtt.connect(url);

client.on('connect', () => {
  console.log('MQTT connected for sendAir');
  const msg = {
    homeId: 'HOME123',
    deviceId: 'AIR-001',
    stream: 'AIR',
    payload: {
      co2: 650 + Math.floor(Math.random() * 150),
      co:  2 + Math.random() * 3,
      pm25: 10 + Math.random() * 10,
      pm10: 20 + Math.random() * 10,
      temp: 24 + Math.random() * 2,
      humidity: 45 + Math.random() * 5
    },
    ts: new Date().toISOString()
  };
  client.publish('shega/airnode/data', JSON.stringify(msg), {}, () => {
    console.log('Published AIR telemetry:', msg);
    client.end();
  });
});
