'use strict';
/*
 * Moteur physique du bâtiment simulé.
 *
 * Extrait verbatim du nœud « Physics Simulator » du flow. Les zones sont
 * découvertes dynamiquement depuis les étiquettes de bmsMetadata : ajouter un
 * point correctement étiqueté suffit à l'intégrer à la simulation.
 *
 * Mute `bacnetPoints` en place et rend un résumé du tick.
 */

/**
 * @param {object} bacnetPoints  table des points (mutée)
 * @param {object} bmsMetadata   étiquettes et zones
 * @returns {{changes:number, zoneCount:number, outsideTemp:number}}
 */
function runPhysicsTick(bacnetPoints, bmsMetadata) {
// Get outside conditions
const outsideTemp = bacnetPoints['glob_outside_temp']?.value ?? 15;
const outsideLux = bacnetPoints['glob_outside_lux']?.value ?? 500;

// ===== DYNAMIC ZONE DISCOVERY =====
// Build zone structure from bmsMetadata
const zones = {};

Object.entries(bmsMetadata).forEach(([id, meta]) => {
    if (!meta.zone || !bacnetPoints[id]) return;
    
    const zoneName = meta.zone;
    if (!zones[zoneName]) {
        zones[zoneName] = {
            temp_sensors: [],
            temp_setpoints: [],
            lux_sensors: [],
            lamps: [],
            co2_sensors: [],
            motion_sensors: [],
            vents: []
        };
    }
    
    const tags = meta.tags || [];
    const point = bacnetPoints[id];
    
    // Categorize by tags
    if (tags.includes('sensor') && tags.includes('temperature')) {
        zones[zoneName].temp_sensors.push(id);
    }
    if (tags.includes('actuator') && tags.includes('hvac_temp') && tags.includes('setpoint')) {
        zones[zoneName].temp_setpoints.push(id);
    }
    if (tags.includes('sensor') && tags.includes('light')) {
        zones[zoneName].lux_sensors.push(id);
    }
    if (tags.includes('actuator') && tags.includes('lighting')) {
        zones[zoneName].lamps.push(id);
    }
    if (tags.includes('sensor') && tags.includes('co2')) {
        zones[zoneName].co2_sensors.push(id);
    }
    if (tags.includes('sensor') && (tags.includes('motion') || tags.includes('occupancy'))) {
        zones[zoneName].motion_sensors.push(id);
    }
    if (tags.includes('actuator') && (tags.includes('hvac_vent') || tags.includes('ventilation'))) {
        zones[zoneName].vents.push(id);
    }
});

// ===== HELPER FUNCTIONS =====
// Get average value from multiple sensors
function getAvg(ids) {
    const values = ids.map(id => bacnetPoints[id]?.value).filter(v => v !== undefined);
    if (values.length === 0) return undefined;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

// Get any true value (OR logic for motion)
function getAnyTrue(ids) {
    return ids.some(id => bacnetPoints[id]?.value === true);
}

// Set value to all sensors in list
function setAll(ids, value) {
    ids.forEach(id => {
        if (bacnetPoints[id]) bacnetPoints[id].value = value;
    });
}

let changes = 0;
const zoneCount = Object.keys(zones).length;

// ===== PROCESS EACH ZONE =====
Object.entries(zones).forEach(([zoneName, zone]) => {
    
    // ----- TEMPERATURE PHYSICS -----
    // HVAC is properly dimensioned: always converges to setpoint
    // Thermal exchange with outside creates load, not drift
    if (zone.temp_sensors.length > 0 && zone.temp_setpoints.length > 0) {
        const currentTemp = getAvg(zone.temp_sensors);
        const setpoint = getAvg(zone.temp_setpoints);
        
        if (currentTemp !== undefined && setpoint !== undefined) {
            const error = setpoint - currentTemp;
            
            // Bande morte : la température est arrondie au dixième (ligne ~117),
            // donc toute erreur sous ~0.05 °C produit un netChange qui s'arrondit à
            // zéro. Avec un seuil à 0.02 le bloc tournait en permanence sans rien
            // changer (churn « N updates ») tout en laissant un décalage résiduel.
            // 0.15 °C place la bande morte au-dessus du pas d'arrondi.
            if (Math.abs(error) > 0.15) {
                // Thermal load: heat exchange with outside
                // Positive = losing heat, Negative = gaining heat
                const thermalLoad = (currentTemp - outsideTemp) * 0.008;
                
                // HVAC response: proportional to error, overcomes thermal load
                // HVAC capacity is sized to handle worst case + margin
                const hvacMaxPower = 0.25; // Max degrees per tick
                const hvacGain = 0.4; // Response gain (how aggressively it corrects)
                const hvacResponse = Math.sign(error) * Math.min(hvacMaxPower, Math.abs(error) * hvacGain);
                
                // Net change: HVAC always wins, but thermal load affects rate
                // When error and thermal load are same direction, faster convergence
                // When opposite, slower but still converges
                const netChange = hvacResponse - thermalLoad * 0.3; // HVAC dominates
                
                const newTemp = Math.round((currentTemp + netChange) * 10) / 10;
                const clampedTemp = Math.max(5, Math.min(40, newTemp));
                
                setAll(zone.temp_sensors, clampedTemp);
                // Ne compter que les mouvements réels : le compteur affiché doit
                // dire ce qui a bougé, pas ce qui a été recalculé.
                if (clampedTemp !== currentTemp) changes++;
            }
        }
    }
    
    // ----- LIGHT/LUX PHYSICS -----
    // Lux responds to lamp state + ambient from outside
    if (zone.lux_sensors.length > 0 && zone.lamps.length > 0) {
        const currentLux = getAvg(zone.lux_sensors);
        const anyLampOn = getAnyTrue(zone.lamps);
        
        if (currentLux !== undefined) {
            // Ambient light from outside (windows let in ~2-5% of outside light)
            const ambientLux = Math.min(300, Math.floor(outsideLux * 0.03));
            
            // Target lux based on lamp state
            const lampContribution = anyLampOn ? 450 : 0;
            const targetLux = ambientLux + lampContribution;
            
            const luxError = targetLux - currentLux;
            
            if (Math.abs(luxError) > 5) {
                // Light changes quickly
                const luxChange = Math.sign(luxError) * Math.min(100, Math.abs(luxError) * 0.5);
                const newLux = Math.max(0, Math.round(currentLux + luxChange));
                
                setAll(zone.lux_sensors, newLux);
                changes++;
            }
        }
    }
    
    // ----- CO2 PHYSICS -----
    // Occupancy generates CO2, ventilation removes it
    if (zone.co2_sensors.length > 0 && zone.motion_sensors.length > 0) {
        const currentCO2 = getAvg(zone.co2_sensors);
        const isOccupied = getAnyTrue(zone.motion_sensors);
        
        if (currentCO2 !== undefined) {
            // Outdoor CO2 baseline
            const outdoorCO2 = 420;
            
            // Ventilation rate (0-100% mapped to 0.1-1.0)
            let ventRate = 0.2; // Default 20%
            if (zone.vents.length > 0) {
                const ventValue = getAvg(zone.vents);
                if (ventValue !== undefined) ventRate = Math.max(0.1, ventValue / 100);
            }
            
            // CO2 generation from occupancy (~10-20 ppm per tick when occupied)
            const co2Generation = isOccupied ? 12 : 0;
            
            // Ventilation effect: removes CO2 proportional to (indoor - outdoor) difference
            const co2Removal = (currentCO2 - outdoorCO2) * ventRate * 0.03;
            
            // Natural infiltration (slow leak toward outdoor levels)
            const infiltration = (currentCO2 - outdoorCO2) * 0.002;
            
            const netCO2Change = co2Generation - co2Removal - infiltration;
            
            if (Math.abs(netCO2Change) > 0.5) {
                const newCO2 = Math.round(currentCO2 + netCO2Change);
                const clampedCO2 = Math.max(400, Math.min(3000, newCO2));
                
                setAll(zone.co2_sensors, clampedCO2);
                changes++;
            }
        }
    }
});

    return { changes, zoneCount, outsideTemp };
}

module.exports = { runPhysicsTick };
