import { installIllustratorWorker } from './worker-runtime.js'

installIllustratorWorker(self as unknown as import('./worker-runtime.js').IllustratorWorkerScope)
