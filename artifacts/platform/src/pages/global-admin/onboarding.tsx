import { useState } from "react";
import { 
  useListOnboardingRequests, 
  useUpdateOnboardingRequest, 
  getListOnboardingRequestsQueryKey,
  UpdateOnboardingRequestBodyStatus
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export default function GlobalAdminOnboarding() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [rejectNotes, setRejectNotes] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  
  const queryClient = useQueryClient();
  const updateMutation = useUpdateOnboardingRequest();

  const { data, isLoading } = useListOnboardingRequests(
    statusFilter === "all" ? {} : { status: statusFilter as any },
    { query: { queryKey: ["listOnboardingRequests", statusFilter] } }
  );

  const handleUpdateStatus = (id: number, status: UpdateOnboardingRequestBodyStatus, notes?: string) => {
    updateMutation.mutate(
      { id, data: { status, reviewNotes: notes } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOnboardingRequestsQueryKey() });
          setSelectedId(null);
          setRejectNotes("");
        }
      }
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Onboarding Requests</h1>
          <p className="text-muted-foreground" data-testid="text-subtitle">Review and approve tenant applications.</p>
        </div>
        <div className="w-full sm:w-56">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="rounded-sm bg-card border-border/50" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Requests</SelectItem>
              <SelectItem value="submitted">Submitted</SelectItem>
              <SelectItem value="pending_review">Pending Review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Company</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Contact</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Business Type</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Date</TableHead>
              <TableHead className="text-right font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading requests...
                </TableCell>
              </TableRow>
            ) : data?.requests?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No requests found.
                </TableCell>
              </TableRow>
            ) : (
              data?.requests?.map((req) => (
                <TableRow key={req.id} className="border-border/30 hover:bg-muted/20" data-testid={`row-request-${req.id}`}>
                  <TableCell className="font-medium text-sm">{req.companyName}</TableCell>
                  <TableCell>
                    <div className="text-sm">{req.contactName}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-1">{req.contactEmail}</div>
                  </TableCell>
                  <TableCell className="text-sm">{req.businessType}</TableCell>
                  <TableCell>
                    <Badge variant={req.status === "approved" || req.status === "activated" ? "default" : req.status === "rejected" ? "destructive" : "secondary"} className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">
                      {req.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{new Date(req.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    {req.status === "submitted" || req.status === "pending_review" ? (
                      <div className="flex justify-end gap-2">
                        <Button 
                          size="sm" 
                          variant="outline"
                          className="h-8 rounded-sm bg-green-500/10 text-green-600 hover:bg-green-500/20 hover:text-green-700 border-green-200/50 text-xs font-semibold uppercase tracking-wider"
                          onClick={() => handleUpdateStatus(req.id, "approved")}
                          disabled={updateMutation.isPending}
                          data-testid={`button-approve-${req.id}`}
                        >
                          Approve
                        </Button>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button 
                              size="sm" 
                              variant="outline"
                              className="h-8 rounded-sm bg-red-500/10 text-red-600 hover:bg-red-500/20 hover:text-red-700 border-red-200/50 text-xs font-semibold uppercase tracking-wider"
                              onClick={() => setSelectedId(req.id)}
                              data-testid={`button-reject-${req.id}`}
                            >
                              Reject
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Reject Application</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 pt-4">
                              <Textarea 
                                placeholder="Provide a reason for rejection..." 
                                value={rejectNotes}
                                onChange={(e) => setRejectNotes(e.target.value)}
                                className="rounded-sm resize-none"
                                data-testid="input-reject-notes"
                              />
                              <div className="flex justify-end">
                                <Button 
                                  variant="destructive"
                                  className="rounded-sm uppercase text-xs tracking-wider font-semibold"
                                  disabled={!rejectNotes.trim() || updateMutation.isPending}
                                  onClick={() => handleUpdateStatus(req.id, "rejected", rejectNotes)}
                                  data-testid="button-confirm-reject"
                                >
                                  Confirm Rejection
                                </Button>
                              </div>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" disabled className="h-8 rounded-sm text-xs uppercase tracking-wider font-semibold opacity-50">Processed</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
