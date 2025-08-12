import * as Rapid from './index.js';

// Set up window.Rapid for compatibility with existing code
window.Rapid = Rapid;
window.Rapid.isDebug = false;

// Export everything for ES module usage
export * from './index.js';
