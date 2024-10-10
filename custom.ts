// Enums to be used in extension
enum Signal {
    EMG,
    EEG,
    ECG
}

enum SignalShape {
    DEFAULT,
    CONTROL
}



//% color="#FF805E" icon="\uf188" weight=90
namespace spikerbit {
    const FS = 250; //[Hz]
    const TIME_RANGE = 5000; //[ms]
    const MAX_BUFFER_SIZE = (FS * (TIME_RANGE / 1000));
    const PIN = AnalogPin.P1;

    let buffer: number[] = [];
    let write_index = 0;
    let read_index = 0;
    let signal_label = "EEG"; //Default EEG (right now)

    let envelope_sum: number = 0;
    let envelope_buffer: number[] = [];

    let signalType: Signal = Signal.EMG
    let notInitialized = 1

    const NOISE_FLOOR = 580;
    const ENVELOPE_DECAY = 2;
    
    let envelopeValue: number = 0;

    const ECG_JUMP = 40;
    const DEBOUNCE_PERIOD_ECG = 300;

    let ecgTimestamps: number[] = [];
    let tempCaluclationValue: number = 0
    let lastSample = 0
    let bpmECG: number = 0

    const SAMPLING_RATE: number = 250; // Hz
    const ALPHA_WAVE_FREQUENCY: number = 10; // Hz (Notch frequency)
    const Q: number = 1; // Quality factor
    const BASELINE_ALPHA: number = 20;

    let gInputKeepBuffer: number[] = [0, 0];
    let gOutputKeepBuffer: number[] = [0, 0];

    let tempCalculationValue: number = 0
    let coefficients: number[] = [0, 0, 0, 0, 0];
    let eegSignalPower: number = 0;
    let eegNotchedSignalPower: number = 0;
    let filteredValue: number = 0;
    let eegAlphaPower: number = 0;

    function convolution(new_signal: number) {
        /* 
            Currently, 
            time complexity O(window_size)
            memory space O(window_size) 

        */

        // Initialization
        const window_size = 20; // Arbitray: decided based on smoothness of signal
        const kernel = 1 / window_size; // Have "better" kernel?

        // Just to be safe
        if (isNaN(new_signal)) {
            return 0;
        }

        // If buffer length is less than the window size
        if (envelope_buffer.length < window_size) {
            // Only push to the buffer
            envelope_buffer.push(new_signal);
            envelope_sum = envelope_sum + new_signal;

            return 0;
        }
        // Update the buffer
        else {
            let old_signal = envelope_buffer.shift() as number;
            envelope_buffer.push(new_signal);

            // Perform the convolution(dot product of buffer and "kernel")
            envelope_sum = envelope_sum - old_signal + new_signal;

            return envelope_sum * kernel;
        }
    }

    /**
     * Calculate intermediate variables and set filter coefficients
     */
    function calculateNotchCoefficients(Fc: number, Q: number, Fs: number): void {
        const omega = (2 * Math.PI * Fc) / Fs;
        const omegaS = Math.sin(omega);
        const omegaC = Math.cos(omega);
        const alpha = omegaS / (2 * Q);

        const a0 = 1 + alpha;
        const b0 = 1 / a0;
        const b1 = (-2 * omegaC) / a0;
        const b2 = 1 / a0;
        const a1 = (-2 * omegaC) / a0;
        const a2 = (1 - alpha) / a0;

        // Set the coefficients array
        coefficients[0] = b0;
        coefficients[1] = b1;
        coefficients[2] = b2;
        coefficients[3] = a1;
        coefficients[4] = a2;
    }
    
    function filterSingleSample(inputValue: number): number {
        // Compute the filtered output using the difference equation:
        // y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
        const y = (coefficients[0] * inputValue) +
            (coefficients[1] * gInputKeepBuffer[0]) +
            (coefficients[2] * gInputKeepBuffer[1]) -
            (coefficients[3] * gOutputKeepBuffer[0]) -
            (coefficients[4] * gOutputKeepBuffer[1]);

        // Update the input buffer (shift the samples)
        gInputKeepBuffer[1] = gInputKeepBuffer[0]; // x[n-2] = x[n-1]
        gInputKeepBuffer[0] = inputValue;           // x[n-1] = x[n]

        // Update the output buffer (shift the samples)
        gOutputKeepBuffer[1] = gOutputKeepBuffer[0]; // y[n-2] = y[n-1]
        gOutputKeepBuffer[0] = y;                     // y[n-1] = y[n]

        return y | 0;
    }


    // Define your background function
    function backgroundTask(): void {
        pins.digitalWritePin(DigitalPin.P2, 1)
        const time_delay = 20; //[ms] (delay from write to read)
        const index_delay = Math.ceil(FS / (1000 / time_delay));

        // Initialize all element inside buffer with 0 to avoid NaN reading
        for (let i = 0; i < MAX_BUFFER_SIZE; i++) {
            buffer[i] = 0;
        }

        // background processing
        while (true) {
            lastSample = tempCaluclationValue;

            buffer[write_index] = pins.analogReadPin(PIN);
            tempCaluclationValue = buffer[write_index];

            write_index++;

            // Loop back write_index after reach to end
            if (write_index >= MAX_BUFFER_SIZE) {
                write_index = 0;
            }

            // Caluclation for correct read_index
            if (write_index < index_delay) {
                read_index = MAX_BUFFER_SIZE - (index_delay - write_index);
            }
            else {
                read_index = write_index - index_delay;
            }



            if (signalType == Signal.ECG) {
                if ((tempCaluclationValue - lastSample) > ECG_JUMP) {
                    let currentMillis = control.millis()
                    if (ecgTimestamps.length > 0) {
                        if ((currentMillis - ecgTimestamps[ecgTimestamps.length - 1]) > DEBOUNCE_PERIOD_ECG) {
                            ecgTimestamps.push(currentMillis)
                        }
                    }
                    else {
                        ecgTimestamps.push(currentMillis)
                    }

                    if (ecgTimestamps.length > 3) {
                        ecgTimestamps.removeAt(0)
                        bpmECG = (120000 / (ecgTimestamps[2] - ecgTimestamps[1] + ecgTimestamps[1] - ecgTimestamps[0])) | 0
                    }

                }
            }
            else if (signalType == Signal.EMG) {
                tempCaluclationValue = tempCaluclationValue - NOISE_FLOOR;
                if (tempCaluclationValue > 0) {
                    if (tempCaluclationValue > envelopeValue) {
                        envelopeValue = tempCaluclationValue;
                    }
                }

                envelopeValue = envelopeValue - ENVELOPE_DECAY;

                if (envelopeValue < 0) {
                    envelopeValue = 0;
                }
            }
            else if (signalType = Signal.EEG) {
                eegSignalPower = eegSignalPower * 0.99 + 0.01 * (Math.abs(tempCalculationValue - 512))
                filteredValue = filterSingleSample(tempCalculationValue)
                eegNotchedSignalPower = eegNotchedSignalPower * 0.99 + 0.01 * (Math.abs(filteredValue - 512))
                eegAlphaPower = (eegSignalPower - eegNotchedSignalPower) - BASELINE_ALPHA;
                if (eegAlphaPower < 0) {
                    eegAlphaPower = 0;
                }
            }

            pins.digitalWritePin(DigitalPin.P2, 0);

            basic.pause(0);
        }
    }



    /**
     * Start recording EMG signal 
     */

    //% group="Initialization"
    //% weight=45 
    //% block="startMuscleRecording"
    export function startMuscleRecording(): void {
        signal_label = "EMG";
        signalType = Signal.EMG;
        pins.digitalWritePin(DigitalPin.P8, 1)
        pins.digitalWritePin(DigitalPin.P9, 1)
        if (notInitialized) {
            control.inBackground(() => {
                backgroundTask()
            })
        }
    }


    /**
     * Start recording ECG signal
     */

    //% group="Initialization"
    //% weight=44 
    //% block="startHeartRecording"
    export function startHeartRecording(): void {
        signal_label = "ECG";
        signalType = Signal.ECG;
        pins.digitalWritePin(DigitalPin.P8, 0)
        pins.digitalWritePin(DigitalPin.P9, 1)
        if (notInitialized) {
            control.inBackground(() => {
                backgroundTask()
            })
        }
    }

    /**
 * Start recording EEG signal
 */

    //% group="Initialization"
    //% weight=43 
    //% block="startBrainRecording"
    export function startBrainRecording(): void {
        signal_label = "EEG";
        signalType = Signal.EEG;
        pins.digitalWritePin(DigitalPin.P8, 0)
        pins.digitalWritePin(DigitalPin.P9, 0)
        if (notInitialized) {
            control.inBackground(() => {
                backgroundTask()
            })
        }
    }

    /**
     * Return last measured value of the signal
     */

    //% group="Raw data"
    //% weight=42
    //% block="signal"
    export function signal(): number {
        if (buffer.length > 0) {
            return buffer[read_index];
        }
        else {
            return 0;
        }
    }

    /**
     * Return two seconds of recorded signal
     */

    //% group="Raw data"
    //% weight=41 
    //% block="signalBlock"
    export function signalBlock(): number[] {
        return buffer;
    }

    // /**
    //  * Return user defined seconds of recorded signal
    //  */

    // //% group="Raw data"
    // //% weight=41 
    // //% block="signalBlock  || from last $ms (ms)"
    // //% ms.shadow=timePicker
    // //% ms.defl = 5000
    // export function getBuffer(ms: number): number[] {
    //     if (ms == TIME_RANGE) {
    //         return buffer;
    //     }
    //     else if (ms < 0 || ms > TIME_RANGE) {
    //         return [0];
    //     }
    //     else {
    //         let required_size = Math.ceil((FS * (ms / 1000.0)));;

    //         let start_idx = (read_index - (required_size - 1) + MAX_BUFFER_SIZE) % MAX_BUFFER_SIZE; // Start index (wrapped)
    //         let end_idx = (read_index + 1) % MAX_BUFFER_SIZE; // End index is always read_idx + 1 (assuming read_index is newest)

    //         if (start_idx < end_idx) {
    //             // If the range fits without wrapping around
    //             return buffer.slice(start_idx, end_idx);
    //         } else {
    //             // If the range wraps around, slice in two parts then concatinate
    //             return buffer.slice(start_idx, MAX_BUFFER_SIZE).concat(buffer.slice(0, end_idx));
    //         }
    //     }
    // }

    /**
         * Return last envelope value
         */

    //% group="Processed data"
    //% weight=40
    //% block="musclePower"
    export function musclePower(): number {
        if (buffer.length > 0) {
            // Obtain the signal + set baseline to 0
            let measurement = signal() - 512;
            // Rectify the signal
            let rectified_signal = Math.abs(measurement);

            // Serial Out the signal
            return convolution(rectified_signal);
            
            // return envelopeValue;
        }
        else {
            return 0;
        }
    }

    /**
         * Return heart rate
         */

    //% group="Processed data"
    //% weight=39
    //% block="heartRate"
    export function heartRate(): number {
        return bpmECG;
    }

    /**
         * Return alpha waves power
         */

    //% group="Processed data"
    //% weight=38
    //% block="brainAlphaPower"
    export function brainAlphaPower(): number {
        return eegAlphaPower;
    }


    //% group="Experiments helper"
    //% weight=30
    //% block="max singal from $duration (ms) || * $constant"
    //% expandableArgumentMode="enable"
    //% duration.shadow=timePicker
    //% duration.defl=1000
    //% constant.defl=1
    export function maxSignal(duration: number, constant?: number): number {
        if (duration < 0 || constant < 0) {
            return undefined;
        }

        const startTimer = control.millis();
        let val = 0;
        let max_val = 0;
        
        while (control.millis() - startTimer < duration) {
            val = musclePower();

            if (max_val < val) {
                max_val = val;
            }

            basic.pause(0);
        }

        return max_val * constant;
    }

    //% group="Experiments helper"
    //% weight=29
    //% block="number of spikes from $duration (ms)"
    //% duration.shadow=timePicker
    //% duration.defl=3000
    export function spikes(duration: number): number {
        basic.pause(50); //To avoid weird spike happen when turning on

        if (duration < 0) {
            return undefined;
        }
        
        const THRESHOLD = 25;

        let signal = 0;
        let counter = 0;
        let check_once = false;

        const startTimer = control.millis();
        while (control.millis() - startTimer < duration) {
            signal = musclePower();

            while (signal > THRESHOLD) {
                // Means user is holding
                if (control.millis() - startTimer > duration) {
                    return -1;
                }
                signal = musclePower();
                check_once = true;
                basic.pause(0);
            }

            // Allow counter to go up only once above the threshold
            if (check_once) {
                counter++;
                check_once = false;
            }

            basic.pause(0);
        }

        return counter;
    }


    //% group="Experiments helper"
    //% weight=28
    //% block="reaction time|| with threshold $threshold"
    //% expandableArgumentMode="enable"
    //% threshold.defl=50
    export function reactionTime(threshold?: number): number {
        basic.pause(10); //To avoid weird spike happen when turning on

        if (threshold < 0) {
            return undefined;
        }

        const time_limit = 10000; // Maximum 10 seconds to make reaction
        let signal = 0;
        let result_time = 0;

        const startTime = control.millis();

        signal = musclePower();
        while (signal < threshold) {
            signal = musclePower();
            result_time = control.millis() - startTime;
            if (result_time > time_limit) return time_limit;
            basic.pause(0);
        }

        return result_time;
    }

    //% group="Other"
    //% weight=20
    //% block="print $shape signal ||for $duration (ms)"
    //% shape.defl = 0
    //% duration.shadow=timePicker
    //% expandableArgumentMode="enable"
    //% duration.defl=0
    export function print(shape: SignalShape, duration?: number) {
        let startTime = 0;

        // Default: show serial output forever
        if (duration == 0) {
            while (true) {
                if (shape == SignalShape.CONTROL) {
                    // Obtain the signal + set baseline to 0
                    // let measurement = signal() - 512;
                    // Rectify the signal
                    // let rectified_signal = Math.abs(measurement);

                    // Serial Out the signal
                    // serial.writeValue(signal_label, convolution(rectified_signal));
                    serial.writeValue(signal_label, musclePower());
                }
                else {
                    // Serial Out the signal
                    serial.writeValue(signal_label, signal());
                }
            }
        }
        // Optional: show serial output as long as duration
        else {
            let debug_count = 0;
            startTime = control.millis();
            while (control.millis() - startTime < duration) {
                if (shape == SignalShape.CONTROL) {
                    // Obtain the signal + set baseline to 0
                    // let measurement = signal() - 512;
                    // Rectify the signal
                    // let rectified_signal = Math.abs(measurement);

                    // Serial Out the signal
                    // serial.writeValue(signal_label, convolution(rectified_signal));
                    serial.writeValue(signal_label, musclePower());
                }
                else {
                    // Serial Out the signal
                    debug_count++;
                    serial.writeValue(signal_label, signal());
                }
            }
            basic.showNumber(debug_count);
        }
    }


}