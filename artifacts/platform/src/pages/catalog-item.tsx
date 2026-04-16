import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { 
  useGetCatalogItem, 
  useUpdateCatalogItem, 
  useDeleteCatalogItem, 
  useGetCurrentUser,
  getGetCatalogItemQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Edit, Trash, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function CatalogItemDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", price: 0, category: "", description: "" });

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const canEdit = user?.role === "admin" || user?.role === "supervisor";

  const { data: item, isLoading, isError } = useGetCatalogItem(
    id,
    { query: { enabled: !!id, queryKey: getGetCatalogItemQueryKey(id) } }
  );

  const updateMutation = useUpdateCatalogItem();
  const deleteMutation = useDeleteCatalogItem();

  const handleOpenEdit = () => {
    if (item) {
      setEditForm({ name: item.name, price: item.price, category: item.category, description: item.description || "" });
      setIsEditOpen(true);
    }
  };

  const handleUpdate = () => {
    updateMutation.mutate({ id, data: editForm }, {
      onSuccess: () => {
        setIsEditOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetCatalogItemQueryKey(id) });
      }
    });
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this product?")) {
      deleteMutation.mutate({ id }, {
        onSuccess: () => {
          setLocation("/catalog");
        }
      });
    }
  };

  if (isLoading) return <div className="p-8 flex items-center"><Loader2 className="animate-spin mr-2"/> Loading product details...</div>;
  if (isError || !item) return <div className="p-8 text-destructive">Product not found.</div>;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="flex items-start gap-4 pb-6 border-b border-border/50">
        <Link href="/catalog" className="mt-1.5 text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-4xl font-bold tracking-tight" data-testid="text-product-name">{item.name}</h1>
            {!item.isAvailable && <Badge variant="destructive" className="uppercase text-[10px]">Unavailable</Badge>}
          </div>
          <p className="text-muted-foreground font-mono text-sm">SKU: {item.sku || "N/A"}</p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-sm" onClick={handleOpenEdit} data-testid="button-edit">
                  <Edit className="mr-2" size={14} /> Edit
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Edit Product</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <Input 
                    placeholder="Product Name" 
                    value={editForm.name} 
                    onChange={e => setEditForm(prev => ({...prev, name: e.target.value}))}
                  />
                  <Input 
                    type="number" 
                    placeholder="Price" 
                    value={editForm.price} 
                    onChange={e => setEditForm(prev => ({...prev, price: parseFloat(e.target.value)}))}
                  />
                  <Input 
                    placeholder="Category" 
                    value={editForm.category} 
                    onChange={e => setEditForm(prev => ({...prev, category: e.target.value}))}
                  />
                  <Textarea 
                    placeholder="Description" 
                    value={editForm.description} 
                    onChange={e => setEditForm(prev => ({...prev, description: e.target.value}))}
                  />
                  <div className="flex justify-end pt-2">
                    <Button onClick={handleUpdate} disabled={updateMutation.isPending} data-testid="button-save-edit">
                      {updateMutation.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            <Button variant="outline" size="sm" className="rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20" onClick={handleDelete} data-testid="button-delete">
              <Trash className="mr-2" size={14} /> Delete
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Card className="overflow-hidden border-border/50 shadow-sm rounded-sm">
          <div className="aspect-square bg-muted/20 flex items-center justify-center text-muted-foreground p-8">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.name} className="w-full h-full object-contain mix-blend-multiply" />
            ) : (
              <span className="font-mono text-xs uppercase tracking-widest">No Image Available</span>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="border-border/50 shadow-sm rounded-sm">
            <CardContent className="p-8 space-y-6">
              <div>
                <div className="text-xs font-mono font-medium text-muted-foreground mb-2 uppercase tracking-wider">Pricing</div>
                <div className="flex items-end gap-3">
                  <div className="text-5xl font-light tracking-tight" data-testid="text-product-price">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                  {item.compareAtPrice && (
                    <div className="text-xl text-muted-foreground line-through mb-1">
                      ${item.compareAtPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 pt-6 border-t border-border/50">
                <div>
                  <div className="text-xs font-mono font-medium text-muted-foreground mb-1 uppercase tracking-wider">Category</div>
                  <div className="font-medium text-sm" data-testid="text-product-category">{item.category}</div>
                </div>
                <div>
                  <div className="text-xs font-mono font-medium text-muted-foreground mb-1 uppercase tracking-wider">Stock</div>
                  <div className="font-medium text-sm">{item.stockQuantity ?? "Unlimited"}</div>
                </div>
              </div>

              {item.description && (
                <div className="pt-6 border-t border-border/50">
                  <div className="text-xs font-mono font-medium text-muted-foreground mb-2 uppercase tracking-wider">Description</div>
                  <p className="text-sm leading-relaxed text-foreground/90">{item.description}</p>
                </div>
              )}

              {item.tags && item.tags.length > 0 && (
                <div className="pt-6 border-t border-border/50">
                  <div className="text-xs font-mono font-medium text-muted-foreground mb-3 uppercase tracking-wider">Tags</div>
                  <div className="flex flex-wrap gap-2">
                    {item.tags.map(tag => (
                      <Badge key={tag} variant="secondary" className="rounded-sm font-mono text-[10px] px-2 uppercase">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
