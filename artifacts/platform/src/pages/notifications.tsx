import { useListNotifications, useMarkNotificationRead, getListNotificationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Check, Package, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Notifications() {
  const queryClient = useQueryClient();
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
      case 'order_status': return <Package size={16} className="text-primary" />;
      case 'admin_alert': return <ShieldAlert size={16} className="text-destructive" />;
      default: return <Bell size={16} className="text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-end justify-between border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Notifications</h1>
          <p className="text-muted-foreground" data-testid="text-subtitle">Stay updated on order changes and platform alerts.</p>
        </div>
        {data?.unreadCount !== undefined && data.unreadCount > 0 && (
          <div className="text-xs font-mono font-bold bg-primary/10 text-primary px-3 py-1.5 rounded-sm uppercase tracking-widest" data-testid="badge-unread-count">
            {data.unreadCount} unread
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1,2,3].map(i => <Card key={i} className="h-24 animate-pulse bg-muted/20 border-border/50 rounded-sm" />)}
        </div>
      ) : data?.notifications?.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground border border-dashed border-border/50 rounded-sm font-mono text-xs uppercase tracking-widest">
          No notifications.
        </div>
      ) : (
        <div className="space-y-3">
          {data?.notifications?.map(notif => (
            <Card key={notif.id} className={`rounded-sm border-border/50 shadow-sm transition-colors ${!notif.isRead ? 'border-primary/30 bg-primary/5' : 'bg-card hover:bg-muted/10'}`} data-testid={`card-notif-${notif.id}`}>
              <CardContent className="p-4 sm:p-5 flex gap-4">
                <div className="mt-1 shrink-0 bg-background border border-border/50 p-2 rounded-sm shadow-sm h-8 w-8 flex items-center justify-center">
                  {getIcon(notif.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-1 gap-2">
                    <h3 className={`font-semibold text-sm truncate ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>{notif.title}</h3>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest whitespace-nowrap shrink-0">
                      {new Date(notif.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className={`text-sm leading-relaxed ${!notif.isRead ? 'text-foreground/90' : 'text-muted-foreground'}`}>{notif.message}</p>
                </div>
                {!notif.isRead && (
                  <div className="shrink-0 flex items-center pl-4 border-l border-border/30">
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm hover:bg-primary/20 hover:text-primary" onClick={() => handleMarkRead(notif.id)} title="Mark as read" data-testid={`button-mark-read-${notif.id}`}>
                      <Check size={16} />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
