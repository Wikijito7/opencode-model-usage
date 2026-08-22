/**
 * Debug logging — thin adapter over opencode-wlib's `createLog`.
 * Keeps model-usage's env var (`OPENCODE_COPILOT_DEBUG`) and log file
 * naming so call sites and existing log files don't change.
 */

import { createLog } from "../wlib/src/core/log"

export const DEBUG = process.env.OPENCODE_COPILOT_DEBUG === "true"
export const logsDir = new URL("../logs", import.meta.url).pathname
const LOG_FILE_NAME = `log_copilot_plugin_${Date.now()}.log`
export const logPath = `${logsDir}/${LOG_FILE_NAME}`

const logger = createLog({ debug: DEBUG, dir: logsDir, fileName: LOG_FILE_NAME })
export const log = logger.log
