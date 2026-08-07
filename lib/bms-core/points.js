'use strict';
/*
 * Tables de points — la couche matérielle simulée et ses métadonnées
 *
 * bacnetPoints porte le matériel (valeur, unité, accès, bornes), bmsMetadata
 * porte la vue GTB (étiquettes, zone). Cette séparation est la couture prévue
 * pour brancher un vrai réseau BACnet : ne pas la fusionner.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installPoints(ctx) {
    const { global, node, env } = ctx;

const SunCalc = global.get('suncalcModule');

// BACnet points - values only (simulated hardware layer)
const bacnetPoints = {
    // FLOOR 1 - Lobby
    'f1_lobby_temp': { objectName: 'Lobby Temperature', value: 21.5, units: '°C', access: 'read_only' },
    'f1_lobby_hum': { objectName: 'Lobby Humidity', value: 45, units: '%', access: 'read_only' },
    'f1_lobby_co2': { objectName: 'Lobby CO2', value: 450, units: 'ppm', access: 'read_only' },
    'f1_lobby_motion': { objectName: 'Lobby Motion', value: false, units: 'bool', access: 'read_only' },
    'f1_lobby_lux': { objectName: 'Lobby Light Level', value: 300, units: 'lux', access: 'read_only' },
    'f1_lobby_lamp': { objectName: 'Lobby Lamp', value: false, units: 'bool', access: 'read_write' },
    'f1_lobby_temp_setpoint': { objectName: 'Lobby Temp Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f1_lobby_vent': { objectName: 'Lobby Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 1 - Corridor
    'f1_corr_temp': { objectName: 'F1 Corridor Temp', value: 20.5, units: '°C', access: 'read_only' },
    'f1_corr_motion': { objectName: 'F1 Corridor Motion', value: false, units: 'bool', access: 'read_only' },
    'f1_corr_lux': { objectName: 'F1 Corridor Light', value: 150, units: 'lux', access: 'read_only' },
    'f1_corr_lamp': { objectName: 'F1 Corridor Lamp', value: false, units: 'bool', access: 'read_write' },
    'f1_corr_temp_setpoint': { objectName: 'F1 Corridor Setpoint', value: 19, units: '°C', access: 'read_write', min: 15, max: 28 },

    // FLOOR 1 - Meeting Room
    'f1_meet_temp': { objectName: 'Meeting Room Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f1_meet_hum': { objectName: 'Meeting Room Humidity', value: 50, units: '%', access: 'read_only' },
    'f1_meet_co2': { objectName: 'Meeting Room CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f1_meet_motion': { objectName: 'Meeting Room Motion', value: false, units: 'bool', access: 'read_only' },
    'f1_meet_lux': { objectName: 'Meeting Room Light', value: 250, units: 'lux', access: 'read_only' },
    'f1_meet_lamp': { objectName: 'Meeting Room Lamp', value: false, units: 'bool', access: 'read_write' },
    'f1_meet_temp_setpoint': { objectName: 'Meeting Room Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f1_meet_vent': { objectName: 'Meeting Room Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },
    'f1_meet_booking': { objectName: 'Meeting Room Booked', value: false, units: 'bool', access: 'read_write' },

    // FLOOR 1 - Storage
    'f1_stor_temp': { objectName: 'Storage Temp', value: 18.0, units: '°C', access: 'read_only' },
    'f1_stor_motion': { objectName: 'Storage Motion', value: false, units: 'bool', access: 'read_only' },
    'f1_stor_lamp': { objectName: 'Storage Lamp', value: false, units: 'bool', access: 'read_write' },
    'f1_stor_temp_setpoint': { objectName: 'Storage Setpoint', value: 16, units: '°C', access: 'read_write', min: 10, max: 25 },

    // FLOOR 2 - Corridor
    'f2_corr_temp': { objectName: 'F2 Corridor Temp', value: 20.5, units: '°C', access: 'read_only' },
    'f2_corr_motion': { objectName: 'F2 Corridor Motion', value: false, units: 'bool', access: 'read_only' },
    'f2_corr_lux': { objectName: 'F2 Corridor Light', value: 150, units: 'lux', access: 'read_only' },
    'f2_corr_lamp': { objectName: 'F2 Corridor Lamp', value: false, units: 'bool', access: 'read_write' },
    'f2_corr_temp_setpoint': { objectName: 'F2 Corridor Setpoint', value: 19, units: '°C', access: 'read_write', min: 15, max: 28 },

    // FLOOR 2 - Office 1
    'f2_off1_temp': { objectName: 'F2 Office 1 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f2_off1_hum': { objectName: 'F2 Office 1 Humidity', value: 45, units: '%', access: 'read_only' },
    'f2_off1_co2': { objectName: 'F2 Office 1 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f2_off1_motion': { objectName: 'F2 Office 1 Motion', value: false, units: 'bool', access: 'read_only' },
    'f2_off1_lux': { objectName: 'F2 Office 1 Light', value: 400, units: 'lux', access: 'read_only' },
    'f2_off1_lamp': { objectName: 'F2 Office 1 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f2_off1_temp_setpoint': { objectName: 'F2 Office 1 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f2_off1_vent': { objectName: 'F2 Office 1 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 2 - Office 2
    'f2_off2_temp': { objectName: 'F2 Office 2 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f2_off2_hum': { objectName: 'F2 Office 2 Humidity', value: 45, units: '%', access: 'read_only' },
    'f2_off2_co2': { objectName: 'F2 Office 2 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f2_off2_motion': { objectName: 'F2 Office 2 Motion', value: false, units: 'bool', access: 'read_only' },
    'f2_off2_lux': { objectName: 'F2 Office 2 Light', value: 400, units: 'lux', access: 'read_only' },
    'f2_off2_lamp': { objectName: 'F2 Office 2 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f2_off2_temp_setpoint': { objectName: 'F2 Office 2 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f2_off2_vent': { objectName: 'F2 Office 2 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 2 - Office 3
    'f2_off3_temp': { objectName: 'F2 Office 3 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f2_off3_hum': { objectName: 'F2 Office 3 Humidity', value: 45, units: '%', access: 'read_only' },
    'f2_off3_co2': { objectName: 'F2 Office 3 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f2_off3_motion': { objectName: 'F2 Office 3 Motion', value: false, units: 'bool', access: 'read_only' },
    'f2_off3_lux': { objectName: 'F2 Office 3 Light', value: 400, units: 'lux', access: 'read_only' },
    'f2_off3_lamp': { objectName: 'F2 Office 3 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f2_off3_temp_setpoint': { objectName: 'F2 Office 3 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f2_off3_vent': { objectName: 'F2 Office 3 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 3 - Corridor
    'f3_corr_temp': { objectName: 'F3 Corridor Temp', value: 20.5, units: '°C', access: 'read_only' },
    'f3_corr_motion': { objectName: 'F3 Corridor Motion', value: false, units: 'bool', access: 'read_only' },
    'f3_corr_lux': { objectName: 'F3 Corridor Light', value: 150, units: 'lux', access: 'read_only' },
    'f3_corr_lamp': { objectName: 'F3 Corridor Lamp', value: false, units: 'bool', access: 'read_write' },
    'f3_corr_temp_setpoint': { objectName: 'F3 Corridor Setpoint', value: 19, units: '°C', access: 'read_write', min: 15, max: 28 },

    // FLOOR 3 - Office 1
    'f3_off1_temp': { objectName: 'F3 Office 1 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f3_off1_hum': { objectName: 'F3 Office 1 Humidity', value: 45, units: '%', access: 'read_only' },
    'f3_off1_co2': { objectName: 'F3 Office 1 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f3_off1_motion': { objectName: 'F3 Office 1 Motion', value: false, units: 'bool', access: 'read_only' },
    'f3_off1_lux': { objectName: 'F3 Office 1 Light', value: 400, units: 'lux', access: 'read_only' },
    'f3_off1_lamp': { objectName: 'F3 Office 1 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f3_off1_temp_setpoint': { objectName: 'F3 Office 1 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f3_off1_vent': { objectName: 'F3 Office 1 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 3 - Office 2
    'f3_off2_temp': { objectName: 'F3 Office 2 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f3_off2_hum': { objectName: 'F3 Office 2 Humidity', value: 45, units: '%', access: 'read_only' },
    'f3_off2_co2': { objectName: 'F3 Office 2 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f3_off2_motion': { objectName: 'F3 Office 2 Motion', value: false, units: 'bool', access: 'read_only' },
    'f3_off2_lux': { objectName: 'F3 Office 2 Light', value: 400, units: 'lux', access: 'read_only' },
    'f3_off2_lamp': { objectName: 'F3 Office 2 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f3_off2_temp_setpoint': { objectName: 'F3 Office 2 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f3_off2_vent': { objectName: 'F3 Office 2 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // FLOOR 3 - Office 3
    'f3_off3_temp': { objectName: 'F3 Office 3 Temp', value: 21.0, units: '°C', access: 'read_only' },
    'f3_off3_hum': { objectName: 'F3 Office 3 Humidity', value: 45, units: '%', access: 'read_only' },
    'f3_off3_co2': { objectName: 'F3 Office 3 CO2', value: 420, units: 'ppm', access: 'read_only' },
    'f3_off3_motion': { objectName: 'F3 Office 3 Motion', value: false, units: 'bool', access: 'read_only' },
    'f3_off3_lux': { objectName: 'F3 Office 3 Light', value: 400, units: 'lux', access: 'read_only' },
    'f3_off3_lamp': { objectName: 'F3 Office 3 Lamp', value: false, units: 'bool', access: 'read_write' },
    'f3_off3_temp_setpoint': { objectName: 'F3 Office 3 Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
    'f3_off3_vent': { objectName: 'F3 Office 3 Ventilation', value: 20, units: '%', access: 'read_write', min: 0, max: 100 },

    // GLOBAL / OUTSIDE
    'glob_outside_temp': { objectName: 'Outside Temperature', value: 12, units: '°C', access: 'read_only' },
    'glob_outside_lux': { objectName: 'Outside Light Level', value: 8000, units: 'lux', access: 'read_only' }
};

// BMS Metadata - tags and zone assignments (separate from hardware)
const bmsMetadata = {
    'f1_lobby_temp': { tags: ['floor1', 'lobby', 'sensor', 'temperature'], zone: 'F1_Lobby' },
    'f1_lobby_hum': { tags: ['floor1', 'lobby', 'sensor', 'humidity'], zone: 'F1_Lobby' },
    'f1_lobby_co2': { tags: ['floor1', 'lobby', 'sensor', 'co2', 'iaq'], zone: 'F1_Lobby' },
    'f1_lobby_motion': { tags: ['floor1', 'lobby', 'sensor', 'motion', 'occupancy'], zone: 'F1_Lobby' },
    'f1_lobby_lux': { tags: ['floor1', 'lobby', 'sensor', 'light'], zone: 'F1_Lobby' },
    'f1_lobby_lamp': { tags: ['floor1', 'lobby', 'actuator', 'lighting'], zone: 'F1_Lobby' },
    'f1_lobby_temp_setpoint': { tags: ['floor1', 'lobby', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F1_Lobby' },
    'f1_lobby_vent': { tags: ['floor1', 'lobby', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F1_Lobby' },
    'f1_corr_temp': { tags: ['floor1', 'corridor', 'sensor', 'temperature'], zone: 'F1_Corridor' },
    'f1_corr_motion': { tags: ['floor1', 'corridor', 'sensor', 'motion', 'occupancy'], zone: 'F1_Corridor' },
    'f1_corr_lux': { tags: ['floor1', 'corridor', 'sensor', 'light'], zone: 'F1_Corridor' },
    'f1_corr_lamp': { tags: ['floor1', 'corridor', 'actuator', 'lighting'], zone: 'F1_Corridor' },
    'f1_corr_temp_setpoint': { tags: ['floor1', 'corridor', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F1_Corridor' },
    'f1_meet_temp': { tags: ['floor1', 'meeting', 'sensor', 'temperature'], zone: 'F1_Meeting' },
    'f1_meet_hum': { tags: ['floor1', 'meeting', 'sensor', 'humidity'], zone: 'F1_Meeting' },
    'f1_meet_co2': { tags: ['floor1', 'meeting', 'sensor', 'co2', 'iaq'], zone: 'F1_Meeting' },
    'f1_meet_motion': { tags: ['floor1', 'meeting', 'sensor', 'motion', 'occupancy'], zone: 'F1_Meeting' },
    'f1_meet_lux': { tags: ['floor1', 'meeting', 'sensor', 'light'], zone: 'F1_Meeting' },
    'f1_meet_lamp': { tags: ['floor1', 'meeting', 'actuator', 'lighting'], zone: 'F1_Meeting' },
    'f1_meet_temp_setpoint': { tags: ['floor1', 'meeting', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F1_Meeting' },
    'f1_meet_vent': { tags: ['floor1', 'meeting', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F1_Meeting' },
    'f1_meet_booking': { tags: ['floor1', 'meeting', 'booking', 'schedule'], zone: 'F1_Meeting' },
    'f1_stor_temp': { tags: ['floor1', 'storage', 'sensor', 'temperature'], zone: 'F1_Storage' },
    'f1_stor_motion': { tags: ['floor1', 'storage', 'sensor', 'motion', 'occupancy'], zone: 'F1_Storage' },
    'f1_stor_lamp': { tags: ['floor1', 'storage', 'actuator', 'lighting'], zone: 'F1_Storage' },
    'f1_stor_temp_setpoint': { tags: ['floor1', 'storage', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F1_Storage' },
    'f2_corr_temp': { tags: ['floor2', 'corridor', 'sensor', 'temperature'], zone: 'F2_Corridor' },
    'f2_corr_motion': { tags: ['floor2', 'corridor', 'sensor', 'motion', 'occupancy'], zone: 'F2_Corridor' },
    'f2_corr_lux': { tags: ['floor2', 'corridor', 'sensor', 'light'], zone: 'F2_Corridor' },
    'f2_corr_lamp': { tags: ['floor2', 'corridor', 'actuator', 'lighting'], zone: 'F2_Corridor' },
    'f2_corr_temp_setpoint': { tags: ['floor2', 'corridor', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F2_Corridor' },
    'f2_off1_temp': { tags: ['floor2', 'office', 'sensor', 'temperature'], zone: 'F2_Office1' },
    'f2_off1_hum': { tags: ['floor2', 'office', 'sensor', 'humidity'], zone: 'F2_Office1' },
    'f2_off1_co2': { tags: ['floor2', 'office', 'sensor', 'co2', 'iaq'], zone: 'F2_Office1' },
    'f2_off1_motion': { tags: ['floor2', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F2_Office1' },
    'f2_off1_lux': { tags: ['floor2', 'office', 'sensor', 'light'], zone: 'F2_Office1' },
    'f2_off1_lamp': { tags: ['floor2', 'office', 'actuator', 'lighting'], zone: 'F2_Office1' },
    'f2_off1_temp_setpoint': { tags: ['floor2', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F2_Office1' },
    'f2_off1_vent': { tags: ['floor2', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F2_Office1' },
    'f2_off2_temp': { tags: ['floor2', 'office', 'sensor', 'temperature'], zone: 'F2_Office2' },
    'f2_off2_hum': { tags: ['floor2', 'office', 'sensor', 'humidity'], zone: 'F2_Office2' },
    'f2_off2_co2': { tags: ['floor2', 'office', 'sensor', 'co2', 'iaq'], zone: 'F2_Office2' },
    'f2_off2_motion': { tags: ['floor2', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F2_Office2' },
    'f2_off2_lux': { tags: ['floor2', 'office', 'sensor', 'light'], zone: 'F2_Office2' },
    'f2_off2_lamp': { tags: ['floor2', 'office', 'actuator', 'lighting'], zone: 'F2_Office2' },
    'f2_off2_temp_setpoint': { tags: ['floor2', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F2_Office2' },
    'f2_off2_vent': { tags: ['floor2', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F2_Office2' },
    'f2_off3_temp': { tags: ['floor2', 'office', 'sensor', 'temperature'], zone: 'F2_Office3' },
    'f2_off3_hum': { tags: ['floor2', 'office', 'sensor', 'humidity'], zone: 'F2_Office3' },
    'f2_off3_co2': { tags: ['floor2', 'office', 'sensor', 'co2', 'iaq'], zone: 'F2_Office3' },
    'f2_off3_motion': { tags: ['floor2', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F2_Office3' },
    'f2_off3_lux': { tags: ['floor2', 'office', 'sensor', 'light'], zone: 'F2_Office3' },
    'f2_off3_lamp': { tags: ['floor2', 'office', 'actuator', 'lighting'], zone: 'F2_Office3' },
    'f2_off3_temp_setpoint': { tags: ['floor2', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F2_Office3' },
    'f2_off3_vent': { tags: ['floor2', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F2_Office3' },
    'f3_corr_temp': { tags: ['floor3', 'corridor', 'sensor', 'temperature'], zone: 'F3_Corridor' },
    'f3_corr_motion': { tags: ['floor3', 'corridor', 'sensor', 'motion', 'occupancy'], zone: 'F3_Corridor' },
    'f3_corr_lux': { tags: ['floor3', 'corridor', 'sensor', 'light'], zone: 'F3_Corridor' },
    'f3_corr_lamp': { tags: ['floor3', 'corridor', 'actuator', 'lighting'], zone: 'F3_Corridor' },
    'f3_corr_temp_setpoint': { tags: ['floor3', 'corridor', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F3_Corridor' },
    'f3_off1_temp': { tags: ['floor3', 'office', 'sensor', 'temperature'], zone: 'F3_Office1' },
    'f3_off1_hum': { tags: ['floor3', 'office', 'sensor', 'humidity'], zone: 'F3_Office1' },
    'f3_off1_co2': { tags: ['floor3', 'office', 'sensor', 'co2', 'iaq'], zone: 'F3_Office1' },
    'f3_off1_motion': { tags: ['floor3', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F3_Office1' },
    'f3_off1_lux': { tags: ['floor3', 'office', 'sensor', 'light'], zone: 'F3_Office1' },
    'f3_off1_lamp': { tags: ['floor3', 'office', 'actuator', 'lighting'], zone: 'F3_Office1' },
    'f3_off1_temp_setpoint': { tags: ['floor3', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F3_Office1' },
    'f3_off1_vent': { tags: ['floor3', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F3_Office1' },
    'f3_off2_temp': { tags: ['floor3', 'office', 'sensor', 'temperature'], zone: 'F3_Office2' },
    'f3_off2_hum': { tags: ['floor3', 'office', 'sensor', 'humidity'], zone: 'F3_Office2' },
    'f3_off2_co2': { tags: ['floor3', 'office', 'sensor', 'co2', 'iaq'], zone: 'F3_Office2' },
    'f3_off2_motion': { tags: ['floor3', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F3_Office2' },
    'f3_off2_lux': { tags: ['floor3', 'office', 'sensor', 'light'], zone: 'F3_Office2' },
    'f3_off2_lamp': { tags: ['floor3', 'office', 'actuator', 'lighting'], zone: 'F3_Office2' },
    'f3_off2_temp_setpoint': { tags: ['floor3', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F3_Office2' },
    'f3_off2_vent': { tags: ['floor3', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F3_Office2' },
    'f3_off3_temp': { tags: ['floor3', 'office', 'sensor', 'temperature'], zone: 'F3_Office3' },
    'f3_off3_hum': { tags: ['floor3', 'office', 'sensor', 'humidity'], zone: 'F3_Office3' },
    'f3_off3_co2': { tags: ['floor3', 'office', 'sensor', 'co2', 'iaq'], zone: 'F3_Office3' },
    'f3_off3_motion': { tags: ['floor3', 'office', 'sensor', 'motion', 'occupancy'], zone: 'F3_Office3' },
    'f3_off3_lux': { tags: ['floor3', 'office', 'sensor', 'light'], zone: 'F3_Office3' },
    'f3_off3_lamp': { tags: ['floor3', 'office', 'actuator', 'lighting'], zone: 'F3_Office3' },
    'f3_off3_temp_setpoint': { tags: ['floor3', 'office', 'actuator', 'hvac_temp', 'setpoint'], zone: 'F3_Office3' },
    'f3_off3_vent': { tags: ['floor3', 'office', 'actuator', 'hvac_vent', 'ventilation'], zone: 'F3_Office3' },
    'glob_outside_temp': { tags: ['global', 'weather', 'sensor', 'temperature'], zone: 'External' },
    'glob_outside_lux': { tags: ['global', 'weather', 'sensor', 'light'], zone: 'External' }
};

// Virtual points (computed/system values)
const defaultLat = 48.8566;
const defaultLon = 2.3522;

const virtualPoints = {
    'physics_enabled': { name: 'Physics Simulator Enabled', value: true, units: 'bool', writable: true }, //enable/disable the integrated physics simulator
    'glob_time_hour': { name: 'Current Hour', value: new Date().getHours(), units: 'h', source: 'system_clock' },
    'glob_time_minutes': { name: 'Minutes Since Midnight', value: new Date().getHours() * 60 + new Date().getMinutes(), units: 'min', source: 'system_clock' },
    'glob_time_day': { name: 'Day of Week', value: new Date().getDay() || 7, units: 'day', source: 'system_clock' },
    'glob_time_minute_of_week': { name: 'Minute of Week', value: 0, units: 'min', source: 'system_clock' },
    'glob_time_epoch_min': { name: 'Epoch Minutes (monotonic, wrap-safe for timers)', value: Math.floor(Date.now() / 60000), units: 'min', source: 'system_clock' },
    'glob_comfort_sp': { name: 'Global Comfort Setpoint', value: 21, units: '°C', writable: true, min: 18, max: 26 },
    'glob_eco_sp': { name: 'Global Eco Setpoint', value: 16, units: '°C', writable: true, min: 12, max: 20 },
    'sun_altitude': { name: 'Sun Altitude', value: 0, units: '°', source: 'suncalc' },
    'sun_azimuth': { name: 'Sun Azimuth', value: 0, units: '°', source: 'suncalc' },
    'sun_is_daylight': { name: 'Is Daylight', value: true, units: 'bool', source: 'suncalc' },
    'sun_sunrise_minutes': { name: 'Sunrise Minutes', value: 420, units: 'min', source: 'suncalc' },
    'sun_sunset_minutes': { name: 'Sunset Minutes', value: 1080, units: 'min', source: 'suncalc' },
    'loc_latitude': { name: 'Latitude', value: defaultLat, units: '°', writable: true },
    'loc_longitude': { name: 'Longitude', value: defaultLon, units: '°', writable: true },
    'loc_timezone': { name: 'Timezone', value: 'Europe/Paris', units: '', writable: true },
    'loc_city': { name: 'City', value: 'Paris', units: '', writable: true },
    'loc_country': { name: 'Country', value: 'France', units: '', writable: true }
};

// Initialize sun position
if (SunCalc) {
    const now = new Date();
    const sunPos = SunCalc.getPosition(now, defaultLat, defaultLon);
    virtualPoints.sun_altitude.value = Math.round(sunPos.altitude * 180 / Math.PI * 10) / 10;
    virtualPoints.sun_azimuth.value = Math.round(sunPos.azimuth * 180 / Math.PI * 10) / 10;
    virtualPoints.sun_is_daylight.value = sunPos.altitude > 0;
    
    const times = SunCalc.getTimes(now, defaultLat, defaultLon);
    if (times.sunrise) {
        virtualPoints.sun_sunrise_minutes.value = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
    }
    if (times.sunset) {
        virtualPoints.sun_sunset_minutes.value = times.sunset.getHours() * 60 + times.sunset.getMinutes();
    }
}

// Preserve runtime edits across redeploys and restarts.
// Precedence: defaults < persisted ('file' store, survives restarts) < current runtime (survives redeploys).
let savedMeta; try { savedMeta = global.get('bmsMetadata', 'file'); } catch (e) { /* file store not configured */ }
if (savedMeta) Object.keys(bmsMetadata).forEach(id => { if (savedMeta[id]) bmsMetadata[id] = savedMeta[id]; });
const prevMeta = global.get('bmsMetadata');
if (prevMeta) Object.keys(bmsMetadata).forEach(id => { if (prevMeta[id]) bmsMetadata[id] = prevMeta[id]; });

let savedLoc; try { savedLoc = global.get('locationSettings', 'file'); } catch (e) { /* file store not configured */ }
if (savedLoc) Object.keys(savedLoc).forEach(id => { if (virtualPoints[id]) virtualPoints[id].value = savedLoc[id]; });
const prevVP = global.get('virtualPoints');
if (prevVP) Object.keys(virtualPoints).forEach(id => {
    if (prevVP[id] && virtualPoints[id].writable) virtualPoints[id].value = prevVP[id].value;
});

// Store in global context
global.set('bacnetPoints', bacnetPoints);
global.set('bmsMetadata', bmsMetadata);
global.set('virtualPoints', virtualPoints);

    return { bacnetPoints, bmsMetadata, virtualPoints };
};
