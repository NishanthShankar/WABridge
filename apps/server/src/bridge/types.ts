export type ConnectionStatus =
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export interface ConnectionHealth {
  status: ConnectionStatus;
  uptime: number;
  connectedAt: string | null;
  lastDisconnect: {
    reason: string;
    code: number;
    at: string;
  } | null;
  reconnectAttempts: number;
  account: {
    phoneNumber: string;
    name: string;
  } | null;
}
