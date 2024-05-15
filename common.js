import fs from 'fs';

// Metrics helper functions
function getMetricPayload(name, labels, value) {
    const labelsStrs = [];

    for (const [k, v] of Object.entries(labels)) {
        if (!v) {
            continue;
        }
        labelsStrs.push(`${k}="${v}"`);
    }

    const allLabelsStr = labelsStrs.join(",");
    return `${name}{${allLabelsStr}} ${value}`;
}

async function pushMetrics(payloads) {
    const filePath = './metrics.txt';  // The path to the file where metrics will be saved

    try {
        // Append the payload to the metrics file, creating the file if it does not exist
        fs.appendFileSync(filePath, payloads + '\n');
        console.log("Metrics pushed to file:", payloads);
    } catch (error) {
        console.error("Error writing metrics to file", error.message);
    }
}

async function sleepAsync(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export { getMetricPayload, pushMetrics, sleepAsync };
