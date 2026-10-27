/**
 * 测试公共设置：把日志静音，避免用例输出里混入候选失败告警。
 * 用法：node --import ./test/_setup.mjs --test test/*.test.mjs
 */
import { setLogger } from '../lib/logger.js'

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
setLogger(silent)
