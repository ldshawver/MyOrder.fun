import { useListNotifications, useMarkNotificationRead, getListNotificationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Package, ShieldAlert, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useGetCurrentUser } from "@workspace/api-client-react";

export default function Notifications() {
  const queryClient = useQueryClient();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  const { requestPermission, permission } = usePushNotifications({
    role: (user?.role || "customer") as "customer" | "staff" | "tenant_admin" | "global_admin",
  });

  const { data, isLoading } = useListNotifications(
    {},
    { query: { queryKey: ["listNotifications"] } }
  );

  const markReadMutation = useMarkNotificationRead();

  const handleMarkRead = (id: number) => {
    markReadMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
        }
      }
    );
  };

  const getIcon = (type: string) => {
    switch(type) {
      case "order_status": return <Package size={16} className="text-primary" />;
      case "admin_alert": return <ShieldAlert size={16} className="text-destructive" />;
      default: return <Bell size={16} className="text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            Notifications
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
            Order updates and platform alerts.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.unreadCount !== undefined && data.unreadCount > 0 && (
            <div className="text-xs font-semibold bg-primary/15 text-primary px-3 py-1.5 rounded-full border border-primary/25" data-testid="badge-unread-count">
              {data.unreadCount} unread
            </div>
          )}
        </div>
      </div>

      {/* Push notification permission banner */}
      {permission === "default" && (
        <div className="glass-card rounded-2xl p-5 border border-primary/20 bg-primary/5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
            <Bell size={18} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold mb-0.5">Enable Push Notifications</div>
            <div className="text-xs text-muted-foreground">
              Get notified instantly when your order status changes.
            </div>
          </div>
          <Button
            onClick={() => requestPermission()}
            className="shrink-0 rounded-xl text-xs font-semibold h-9 px-4"
          >
            Enable
          </Button>
        </div>
      )}

      {permission === "denied" && (
        <div className="glass-card rounded-2xl p-5 border border-border/40 flex items-center gap-4 opacity-70">
          <BellOff size={18} className="text-muted-foreground shrink-0" />
          <div className="text-xs text-muted-foreground">
            Push notifications are blocked. Enable them in your browser settings to receive real-time order updates.
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
          ))}
        </div>
      ) : data?.notifications?.length === 0 ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted/20 flex items-center justify-center mb-4">
            <Bell size={24} className="text-muted-foreground" />
          </div>
          <h3 className="font-semibold text-sm mb-1">All caught up</h3>
          <p className="text-xs text-muted-foreground">No notifications yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.notifications?.map(notif => (
            <div
              key={notif.id}
              className={`glass-card card-hover-glow rounded-2xl p-4 flex gap-4 transition-all ${
                !notif.isRead ? "border-primary/25 bg-primary/4" : ""
              }`}
              data-testid={`card-notif-${notif.id}`}
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                !notif.isRead ? "bg-primary/15 border border-primary/25" : "bg-muted/30 border border-border/40"
              }`}>
                {getIcon(notif.type)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className={`text-sm font-semibold leading-tight ${!notif.isRead ? "" : "text-muted-foreground"}`}>
                    {notif.title}
                  </h3>
                  <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">
                    {new Date(notif.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className={`text-sm leading-relaxed ${!notif.isRead ? "text-foreground/85" : "text-muted-foreground"}`}>
                  {notif.message}
                </p>
              </div>
              {!notif.isRead && (
                <div className="shrink-0 flex items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-xl hover:bg-primary/15 hover:text-primary"
                    onClick={() => handleMarkRead(notif.id)}
                    title="Mark as read"
                    data-testid={`button-mark-read-${notif.id}`}
                  >
                    <Check size={15} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
