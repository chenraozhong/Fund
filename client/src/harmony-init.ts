/**
 * Harmony WebView initialization.
 * This file is imported before the React app starts in the Harmony build.
 * It sets up local-mode routing so all API calls go through the local router
 * instead of HTTP fetch to an Express server.
 */
import { initLocalMode } from './api';
import { dispatch } from '../../server/src/local-router';

// Initialize local mode — all api.ts calls will use the local router
initLocalMode(dispatch);

console.log('[Harmony] Local mode initialized — API calls routed to in-process services');
