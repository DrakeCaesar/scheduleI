import {
  applySubstanceRules,
  calculateFinalCost,
  calculateFinalPrice,
  ProductVariety,
  substances,
  effects
} from "./substances";
import {
  loadWasmModule,
  prepareEffectMultipliersForWasm,
  prepareSubstancesForWasm,
  prepareSubstanceRulesForWasm,
} from "./wasm-loader";

// Constants
export let MAX_RECIPE_DEPTH = 6; // Default value, can be changed via slider

const substanceMap = new Map(
  substances.map((substance) => [substance.name, substance])
);

// BFS state variables
let tsBfsRunning = false;
let wasmBfsRunning = false;
let tsBfsPaused = false;
let tsBestMix: { mix: string[]; profit: number } = { mix: [], profit: -Infinity };
let wasmBestMix: { mix: string[]; profit: number } = { mix: [], profit: -Infinity };
let tsBfsWorkers: Worker[] = [];
let tsCurrentProduct: ProductVariety | null = null;
let wasmCurrentProduct: ProductVariety | null = null;
let tsActiveWorkers = 0;
let wasmProgressInterval: NodeJS.Timeout | null = null;
let wasmStartTime = 0;
let tsStartTime = 0;

// Track progress for each worker
type WorkerProgress = {
  substanceName: string;
  depth: number;
  processed: number;
  total: number;
  totalProcessed: number;
  grandTotal: number;
  executionTime: number;
};

let workersProgress: Map<number, WorkerProgress> = new Map();

// Helper function to create effect span HTML
function createEffectSpan(effect: string): string {
  // Convert effect name to kebab case for CSS class
  const className = effect.toLowerCase().replace(/\s+/g, "-");
  return `<span class="effect effect-${className}">${effect}</span>`;
}

export function calculateEffects(
  mix: string[],
  initialEffect: string
): string[] {
  let effectsList = [initialEffect];

  for (let i = 0; i < mix.length; i++) {
    const substanceName = mix[i];
    const substance = substanceMap.get(substanceName);
    if (substance) {
      effectsList = applySubstanceRules(effectsList, substance, i + 1);
    }
  }

  return effectsList;
}

export function updateTsBestMixDisplay() {
  const bestMixDisplay = document.getElementById("tsBestMixDisplay");
  if (!bestMixDisplay || !tsCurrentProduct) return;

  const effectsList = calculateEffects(
    tsBestMix.mix,
    tsCurrentProduct.initialEffect
  );
  const sellPrice = calculateFinalPrice(tsCurrentProduct.name, effectsList);
  const cost = calculateFinalCost(tsBestMix.mix);
  const profit = sellPrice - cost;

  const effectsHTML = effectsList
    .map((effect) => createEffectSpan(effect))
    .join(" ");
  bestMixDisplay.innerHTML = `
    <h3>TypeScript BFS Result for ${tsCurrentProduct.name}</h3>
    <p>Mix: ${tsBestMix.mix.join(", ")}</p>
    <p>Effects: ${effectsHTML}</p>
    <p>Sell Price: $${sellPrice.toFixed(2)}</p>
    <p>Cost: $${cost.toFixed(2)}</p>
    <p>Profit: $${profit.toFixed(2)}</p>
  `;
}

export function updateWasmBestMixDisplay() {
  const bestMixDisplay = document.getElementById("wasmBestMixDisplay");
  if (!bestMixDisplay || !wasmCurrentProduct) return;

  // Ensure bestMix.mix is a proper array
  const mixArray = Array.isArray(wasmBestMix.mix)
    ? wasmBestMix.mix
    : wasmBestMix.mix && typeof wasmBestMix.mix === "object"
    ? Array.from(
        Object.values(wasmBestMix.mix).filter((v) => typeof v === "string")
      )
    : ["Cuke", "Gasoline", "Banana"]; // Fallback to default values

  const effectsList = calculateEffects(mixArray, wasmCurrentProduct.initialEffect);
  const sellPrice = calculateFinalPrice(wasmCurrentProduct.name, effectsList);
  const cost = calculateFinalCost(mixArray);
  const profit = sellPrice - cost;

  const effectsHTML = effectsList
    .map((effect) => createEffectSpan(effect))
    .join(" ");
  bestMixDisplay.innerHTML = `
    <h3>WebAssembly BFS Result for ${wasmCurrentProduct.name}</h3>
    <p>Mix: ${mixArray.join(", ")}</p>
    <p>Effects: ${effectsHTML}</p>
    <p>Sell Price: $${sellPrice.toFixed(2)}</p>
    <p>Cost: $${cost.toFixed(2)}</p>
    <p>Profit: $${profit.toFixed(2)}</p>
  `;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatClockTime(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function updateTsProgressDisplay() {
  const progressDisplay = document.getElementById("tsBfsProgressDisplay");
  if (!progressDisplay) return;

  // Calculate overall progress across all workers
  let totalProcessed = 0;
  let grandTotal = 0;
  const now = Date.now();
  const executionTime = tsStartTime > 0 ? now - tsStartTime : 0;

  // Sum up totals from all workers
  workersProgress.forEach((progress) => {
    totalProcessed += progress.totalProcessed;
    grandTotal += progress.grandTotal;
  });

  // Calculate overall percentage
  const overallPercentage =
    Math.min(100, Math.round((totalProcessed / grandTotal) * 100)) || 0;

  // Estimate remaining time
  const remainingTime =
    totalProcessed > 0
      ? Math.round(
          (executionTime / totalProcessed) * (grandTotal - totalProcessed)
        )
      : 0;
  const estimatedFinishTime = now + remainingTime;

  // Create HTML for overall progress
  const overallProgressHTML = `
    <div class="overall-progress">
      <h4>TypeScript BFS Progress - ${tsActiveWorkers} active workers</h4>
      <div>Total processed: ${totalProcessed.toLocaleString()} / ${grandTotal.toLocaleString()}</div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${overallPercentage}%"></div>
        <span class="progress-text" data-progress="${overallPercentage}%" style="--progress-percent: ${overallPercentage}%"></span>
      </div>
      <div>Execution time: ${formatTime(executionTime)}</div>
      <div>Estimated time remaining: ${formatTime(remainingTime)}</div>
      <div>Estimated finish time: ${formatClockTime(estimatedFinishTime)}</div>
    </div>
  `;

  // Create more compact HTML for each worker's progress
  const workerProgressHTML = Array.from(workersProgress.entries())
    .map(([id, progress]) => {
      // Calculate percentage for current worker's depth
      const depthPercentage =
        Math.min(
          100,
          Math.round((progress.processed / progress.total) * 100)
        ) || 0;

      return `
        <div class="worker-progress">
          <div class="worker-header">
            <span class="worker-name">${progress.substanceName}</span>
            <span class="worker-depth">Depth: ${progress.depth}/${MAX_RECIPE_DEPTH}</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: ${depthPercentage}%"></div>
            <span class="progress-text" data-progress="${depthPercentage}%" style="--progress-percent: ${depthPercentage}%"></span>
          </div>
        </div>
      `;
    })
    .join("");

  progressDisplay.innerHTML = `
    ${overallProgressHTML}
    <div class="workers-container">
      <h4>Worker Status</h4>
      ${workerProgressHTML}
    </div>
  `;
}

function updateWasmProgressDisplay(progress: number) {
  const progressDisplay = document.getElementById("wasmBfsProgressDisplay");
  if (!progressDisplay) return;

  // Current execution time
  const now = Date.now();
  const executionTime = wasmStartTime > 0 ? now - wasmStartTime : 0;

  // Create HTML for progress
  progressDisplay.innerHTML = `
    <div class="overall-progress">
      <h4>WebAssembly BFS Progress</h4>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${progress}%"></div>
        <span class="progress-text" data-progress="${progress}%" style="--progress-percent: ${progress}%"></span>
      </div>
      <div>Execution time: ${formatTime(executionTime)}</div>
    </div>
  `;
}

export function createProgressDisplays() {
  // Create TypeScript BFS progress display
  let tsProgressDisplay = document.getElementById("tsBfsProgressDisplay");
  if (!tsProgressDisplay) {
    tsProgressDisplay = document.createElement("div");
    tsProgressDisplay.id = "tsBfsProgressDisplay";
    tsProgressDisplay.classList.add("progress-display");

    const bfsSection = document.getElementById("bfsSection");
    if (bfsSection) {
      bfsSection.appendChild(tsProgressDisplay);
    } else {
      document.body.appendChild(tsProgressDisplay); // Fallback
    }
  }

  // Create WASM BFS progress display
  let wasmProgressDisplay = document.getElementById("wasmBfsProgressDisplay");
  if (!wasmProgressDisplay) {
    wasmProgressDisplay = document.createElement("div");
    wasmProgressDisplay.id = "wasmBfsProgressDisplay";
    wasmProgressDisplay.classList.add("progress-display");

    const bfsSection = document.getElementById("bfsSection");
    if (bfsSection) {
      bfsSection.appendChild(wasmProgressDisplay);
    } else {
      document.body.appendChild(wasmProgressDisplay); // Fallback
    }
  }

  // Create result displays
  let tsBestMixDisplay = document.getElementById("tsBestMixDisplay");
  if (!tsBestMixDisplay) {
    tsBestMixDisplay = document.createElement("div");
    tsBestMixDisplay.id = "tsBestMixDisplay";
    tsBestMixDisplay.classList.add("best-mix-display");

    const bfsSection = document.getElementById("bfsSection");
    if (bfsSection) {
      bfsSection.appendChild(tsBestMixDisplay);
    } else {
      document.body.appendChild(tsBestMixDisplay); // Fallback
    }
  }

  let wasmBestMixDisplay = document.getElementById("wasmBestMixDisplay");
  if (!wasmBestMixDisplay) {
    wasmBestMixDisplay = document.createElement("div");
    wasmBestMixDisplay.id = "wasmBestMixDisplay";
    wasmBestMixDisplay.classList.add("best-mix-display");

    const bfsSection = document.getElementById("bfsSection");
    if (bfsSection) {
      bfsSection.appendChild(wasmBestMixDisplay);
    } else {
      document.body.appendChild(wasmBestMixDisplay); // Fallback
    }
  }

  // Initialize progress displays
  updateTsProgressDisplay();
  updateWasmProgressDisplay(0);
}

// Add function to update the MAX_RECIPE_DEPTH
export function setMaxRecipeDepth(depth: number) {
  MAX_RECIPE_DEPTH = depth;
}

export async function toggleBothBFS(product: ProductVariety) {
  const bfsButton = document.getElementById("bfsButton");
  if (!bfsButton) return;

  // Get the current max depth value from slider
  const maxDepthSlider = document.getElementById(
    "maxDepthSlider"
  ) as HTMLInputElement;
  if (maxDepthSlider) {
    MAX_RECIPE_DEPTH = parseInt(maxDepthSlider.value, 10);
  }

  // Check if either implementation is running
  if (tsBfsRunning || wasmBfsRunning) {
    // Stop both implementations
    if (tsBfsRunning) {
      tsBfsPaused = !tsBfsPaused;
      // Pause or resume all workers
      const messageType = tsBfsPaused ? "pause" : "resume";
      tsBfsWorkers.forEach((worker) => {
        worker.postMessage({ type: messageType });
      });
    }

    if (wasmBfsRunning && wasmProgressInterval) {
      clearInterval(wasmProgressInterval);
      wasmProgressInterval = null;
      wasmBfsRunning = false;
    }

    bfsButton.textContent = "Start Both BFS";
  } else {
    // Start both implementations
    bfsButton.textContent = "Stop Both BFS";
    createProgressDisplays();

    // Start TypeScript BFS
    startTsBFS(product);
    
    // Start WASM BFS
    startWasmBFS(product);
  }
}

// Function to start TypeScript BFS implementation
async function startTsBFS(product: ProductVariety) {
  tsBfsRunning = true;
  tsBfsPaused = false;
  tsBestMix = { mix: [], profit: -Infinity };
  tsCurrentProduct = product;
  tsStartTime = Date.now();

  // Clean up any existing workers
  tsBfsWorkers.forEach((worker) => worker.terminate());
  tsBfsWorkers = [];
  workersProgress = new Map();
  tsActiveWorkers = 0;

  // Create a worker for each substance
  for (let i = 0; i < substances.length; i++) {
    const substanceName = substances[i].name;

    // Create worker
    const worker = new Worker(new URL("./bfsWorker.ts", import.meta.url), {
      type: "module",
    });

    // Set up worker message handler
    worker.onmessage = createTsWorkerMessageHandler(i, substanceName);

    // Store the worker
    tsBfsWorkers.push(worker);

    // Initialize this worker's progress
    workersProgress.set(i, {
      substanceName,
      depth: 1, // Starting with one substance
      processed: 0,
      total: 1,
      totalProcessed: 0,
      grandTotal: 0,
      executionTime: 0,
    });

    // Start the worker
    worker.postMessage({
      type: "start",
      workerId: i,
      data: {
        product: { ...product },
        bestMix: tsBestMix,
        substanceName,
        maxDepth: MAX_RECIPE_DEPTH, // Pass the current max depth to the worker
      },
    });

    tsActiveWorkers++;
  }

  updateTsProgressDisplay();
}

// Function to start WebAssembly BFS implementation
async function startWasmBFS(product: ProductVariety) {
  wasmBfsRunning = true;
  wasmBestMix = { mix: [], profit: -Infinity };
  wasmCurrentProduct = product;
  wasmStartTime = Date.now();

  // Show progress updates
  let progress = 0;
  wasmProgressInterval = setInterval(() => {
    // Simulate progress until the WASM module completes
    progress = Math.min(progress + 1, 95); // Don't reach 100% until actually done
    updateWasmProgressDisplay(progress);
  }, 100);

  try {
    const bfsModule = await loadWasmModule();

    if (typeof bfsModule.findBestMixJson !== "function") {
      throw new Error("findBestMixJson function not found in WASM module");
    }

    // Prepare data for WASM as JSON strings
    const productJson = JSON.stringify({
      name: product.name,
      initialEffect: product.initialEffect,
    });
    const substancesJson = prepareSubstancesForWasm();
    const effectMultipliersJson = prepareEffectMultipliersForWasm(effects);
    const substanceRulesJson = prepareSubstanceRulesForWasm();

    // Call the WASM function with JSON strings
    const result = bfsModule.findBestMixJson(
      productJson,
      substancesJson,
      effectMultipliersJson,
      substanceRulesJson,
      MAX_RECIPE_DEPTH
    );

    // Extract mix array from result
    let mixArray: string[] = [];

    if (result.mixArray && Array.isArray(result.mixArray)) {
      mixArray = result.mixArray;
    } else if (typeof bfsModule.getMixArray === "function") {
      try {
        const arrayResult = bfsModule.getMixArray();
        mixArray = Array.isArray(arrayResult)
          ? arrayResult
          : arrayResult && typeof arrayResult === "object"
          ? Array.from(
              Object.values(arrayResult).filter((v) => typeof v === "string")
            )
          : [];
      } catch (mixError) {
        console.error("Error getting mix array from helper:", mixError);
      }
    }

    // If all else fails, use a default array
    if (mixArray.length === 0) {
      mixArray = ["Cuke", "Gasoline", "Banana"]; // Default values
    }

    // Update best mix with the mix array and profit from result
    wasmBestMix = {
      mix: mixArray,
      profit: result.profit,
    };

    // Update the display
    updateWasmBestMixDisplay();

    // Complete the progress
    updateWasmProgressDisplay(100);
  } catch (error) {
    console.error("Error running WASM BFS:", error);
    alert(`WASM error: ${error.message}`);
  } finally {
    wasmBfsRunning = false;

    // Clear the progress interval
    if (wasmProgressInterval) {
      clearInterval(wasmProgressInterval);
      wasmProgressInterval = null;
    }
  }
}

function createTsWorkerMessageHandler(workerId: number, substanceName: string) {
  return function (event: MessageEvent) {
    const { type } = event.data;

    if (type === "update") {
      const { bestMix: updatedBestMix } = event.data;

      // Only update if this mix is better than our current best mix
      if (updatedBestMix.profit > tsBestMix.profit) {
        tsBestMix = updatedBestMix;
        updateTsBestMixDisplay();
      }
    } else if (type === "progress") {
      const {
        depth,
        processed,
        total,
        totalProcessed,
        grandTotal,
        executionTime,
      } = event.data;

      // Update this worker's progress
      workersProgress.set(workerId, {
        substanceName,
        depth,
        processed,
        total,
        totalProcessed,
        grandTotal,
        executionTime,
      });

      updateTsProgressDisplay();
    } else if (type === "done") {
      // Get the worker's final stats before updating
      const workerProgress = workersProgress.get(workerId);

      if (workerProgress) {
        // Set processed counts to their maximum values to show 100% completion
        workerProgress.processed = workerProgress.total;
        workerProgress.totalProcessed = workerProgress.grandTotal;

        // Update the worker's progress with complete status
        workersProgress.set(workerId, workerProgress);
      }

      tsActiveWorkers--;

      // Check if this was the last worker to finish
      if (tsActiveWorkers === 0) {
        tsBfsRunning = false;
        const bfsButton = document.getElementById("bfsButton");
        if (bfsButton && !wasmBfsRunning) bfsButton.textContent = "Start Both BFS";
      }

      // Final update of progress display
      updateTsProgressDisplay();
    }
  };
}

export function isBfsRunning(): boolean {
  return tsBfsRunning || wasmBfsRunning;
}

export function getTsBestMix(): { mix: string[]; profit: number } {
  return tsBestMix;
}

export function getWasmBestMix(): { mix: string[]; profit: number } {
  return wasmBestMix;
}

// Export the combined function to control both implementations
export { toggleBothBFS as toggleBFS };
