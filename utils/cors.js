/**
 * Shared CORS utility for all API endpoints
 * Validates origin against ALLOWED_ORIGINS environment variable
 */
import { log } from '../logger.js';

/**
 * Apply CORS headers to response
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @returns {boolean} - Returns false if origin is forbidden, true if allowed
 */
export function applyCORS(req, res) {
  // Get allowed origins from environment variable (comma-separated)
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
  const allowedOrigins = allowedOriginsEnv.split(',').map(origin => origin.trim());

  // If no origins configured, reject (fail-safe)
  if (allowedOrigins.length === 0 || allowedOrigins[0] === '') {
    log('error', 'cors_config_missing');
    res.status(500).json({ error: 'CORS configuration error' });
    return false;
  }

  // Get origin from request header
  const origin = req.headers.origin;

  // Check if origin is allowed
  if (origin && allowedOrigins.includes(origin)) {
    // Origin is allowed - set CORS headers
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

    log('debug', 'cors_allowed_origin', { origin });
    return true;
  } else {
    // Origin not allowed or missing
    log('warn', 'cors_forbidden_origin', { origin: origin || 'none' });
    res.status(403).json({ error: 'Forbidden origin' });
    return false;
  }
}

/**
 * Handle OPTIONS preflight request
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @returns {boolean} - Returns true if request was OPTIONS (handled), false otherwise
 */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    // Apply CORS headers for preflight
    if (applyCORS(req, res)) {
      res.status(200).end();
    }
    return true; // Request was OPTIONS
  }
  return false; // Request was not OPTIONS
}
