const mqtt = require('mqtt');

// Test MQTT connection and simulate device data
const client = mqtt.connect('mqtt://test.mosquitto.org:1883');

client.on('connect', () => {
    console.log('✓ Connected to MQTT broker for testing');
    
    // Subscribe to all SHEGA topics
    const topics = [
        'shega/airnode/data',
        'shega/stovenode/data', 
        'shega/stovenode/control',
        'shega/alerts'
    ];
    
    topics.forEach(topic => {
        client.subscribe(topic);
        console.log(`✓ Subscribed to ${topic}`);
    });
    
    // Test publishing sample data
    console.log('\n📤 Publishing test data...\n');
    
    // Simulate AirNode data
    setTimeout(() => {
        const airNodeData = {
            deviceId: "airnode_001",
            timestamp: Date.now(),
            temperature: 23.5,
            humidity: 45.2,
            smokeLevel: 120,
            gasConcentration: 15.3,
            safetyLevel: "safe",
            wifiConnected: true,
            mqttConnected: true,
            rssi: -45
        };
        
        client.publish('shega/airnode/data', JSON.stringify(airNodeData));
        console.log('📨 Published AirNode test data');
    }, 1000);
    
    // Simulate StoveNode data
    setTimeout(() => {
        const stoveNodeData = {
            deviceId: "stovenode_001",
            timestamp: Date.now(),
            temperature: 145.2,
            safetyLevel: "warning",
            buzzerActive: false,
            fanSpeed: 128,
            gasValvePosition: 90,
            emergencyMode: false,
            wifiConnected: true,
            mqttConnected: true,
            rssi: -52
        };
        
        client.publish('shega/stovenode/data', JSON.stringify(stoveNodeData));
        console.log('📨 Published StoveNode test data');
    }, 2000);
    
    // Simulate an alert
    setTimeout(() => {
        const alertData = {
            device: "stovenode_001",
            alertType: "temperature",
            severity: "warning",
            temperature: 275.3,
            timestamp: Date.now(),
            message: "High stove temperature detected!"
        };
        
        client.publish('shega/alerts', JSON.stringify(alertData));
        console.log('🚨 Published test alert');
    }, 3000);
    
    // Test control command
    setTimeout(() => {
        const controlCommand = {
            fanSpeed: 200,
            buzzer: "on"
        };
        
        client.publish('shega/stovenode/control', JSON.stringify(controlCommand));
        console.log('🎛️ Published test control command');
    }, 4000);
    
    // Close connection after tests
    setTimeout(() => {
        console.log('\n✅ Test completed successfully!');
        console.log('💡 You can now test the REST API endpoints:');
        console.log('   - http://localhost:3000/api/system/status');
        console.log('   - http://localhost:3000/api/airnode/latest');
        console.log('   - http://localhost:3000/api/stovenode/latest');
        console.log('   - http://localhost:3000/api/alerts');
        client.end();
    }, 5000);
});

client.on('message', (topic, message) => {
    console.log(`📥 Received on ${topic}:`, JSON.parse(message.toString()));
});

client.on('error', (error) => {
    console.error('❌ MQTT Error:', error);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Check your internet connection');
    console.log('2. Make sure test.mosquitto.org is accessible');
    console.log('3. Try restarting the script');
});

console.log('🧪 Starting MQTT connection test...');
console.log('📡 Connecting to mqtt://test.mosquitto.org:1883');