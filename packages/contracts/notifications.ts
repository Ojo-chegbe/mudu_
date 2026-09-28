export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  href: string;
  createdAt: number;
  readAt: number | null;
}
export interface NotificationFeed {
  items: NotificationItem[];
  unread: number;
}
