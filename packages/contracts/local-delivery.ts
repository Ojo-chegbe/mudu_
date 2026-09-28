export interface LocalDeliveryStatus {
  running: boolean;
  configured: boolean;
  origin: string | null;
  addresses: { name: string; address: string }[];
  error: string | null;
  lastConnectionAt: number | null;
  checkedDevices: number;
}
