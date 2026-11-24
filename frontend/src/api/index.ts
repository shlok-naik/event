import type { Api } from './api';
import { httpApi } from './http';
import { createMockApi } from './mock';

export const API_MODE = (import.meta.env.VITE_API_MODE as string | undefined) === 'http' ? 'http' : 'mock';
export const api: Api = API_MODE === 'http' ? httpApi : createMockApi();
import { setHttpToken } from './http';
export const setAuthToken = (t: string | null) => { setHttpToken(t); api.setToken?.(t); };
export { resetMockData } from './mock';
export { ApiError } from './api';
export type { Api, RealtimeEvent } from './api';
export * from './types';
