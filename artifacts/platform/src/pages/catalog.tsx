import { useState } from "react";
import { 
  useListCatalogItems, 
  useListCatalogCategories, 
  useCreateCatalogItem, 
  useGetCurrentUser,
  getListCatalogItemsQueryKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Search, Plus, Loader2 } from "lucide-react";
import { Link } from "wouter";

export default function Catalog() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newProduct, setNewProduct] = useState({ name: "", price: "", category: "", sku: "" });

  const queryClient = useQueryClient();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  
  const canEdit = user?.role === "global_admin" || user?.role === "tenant_admin";

  const { data: categoriesRes } = useListCatalogCategories({ query: { queryKey: ["listCatalogCategories"] } });
  const { data, isLoading } = useListCatalogItems(
    { search, category: category !== "all" ? category : undefined, limit: 50 },
    { query: { queryKey: ["listCatalogItems", search, category] } }
  );

  const createMutation = useCreateCatalogItem();

  const handleCreate = () => {
    if (!newProduct.name || !newProduct.price || !newProduct.category) return;
    createMutation.mutate({
      data: {
        name: newProduct.name,
        price: parseFloat(newProduct.price),
        category: newProduct.category,
        sku: newProduct.sku,
        isAvailable: true
      }
    }, {
      onSuccess: () => {
        setIsAddOpen(false);
        setNewProduct({ name: "", price: "", category: "", sku: "" });
        queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
      }
    });
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Product Catalog</h1>
          <p className="text-muted-foreground" data-testid="text-subtitle">Browse and manage available inventory.</p>
        </div>
        {canEdit && (
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-product" className="rounded-sm font-medium">
                <Plus size={16} className="mr-2" /> Add Product
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Product</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <Input 
                  placeholder="Product Name" 
                  value={newProduct.name} 
                  onChange={e => setNewProduct(prev => ({...prev, name: e.target.value}))}
                  data-testid="input-new-name"
                />
                <div className="grid grid-cols-2 gap-4">
                  <Input 
                    type="number" 
                    placeholder="Price" 
                    value={newProduct.price} 
                    onChange={e => setNewProduct(prev => ({...prev, price: e.target.value}))}
                    data-testid="input-new-price"
                  />
                  <Input 
                    placeholder="SKU" 
                    value={newProduct.sku} 
                    onChange={e => setNewProduct(prev => ({...prev, sku: e.target.value}))}
                    data-testid="input-new-sku"
                  />
                </div>
                <Input 
                  placeholder="Category" 
                  value={newProduct.category} 
                  onChange={e => setNewProduct(prev => ({...prev, category: e.target.value}))}
                  data-testid="input-new-category"
                />
                <div className="flex justify-end pt-2">
                  <Button onClick={handleCreate} disabled={createMutation.isPending} data-testid="button-save-product">
                    {createMutation.isPending ? "Saving..." : "Save Product"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <Input 
            placeholder="Search SKUs, names..." 
            className="pl-10 rounded-sm bg-background border-border"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="rounded-sm bg-background" data-testid="select-category">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categoriesRes?.categories?.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="animate-spin mr-2" size={24} /> Loading catalog...
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {data?.items?.map(item => (
            <Card key={item.id} className="overflow-hidden flex flex-col rounded-sm border-border/50 shadow-sm transition-all hover:border-border hover:shadow-md" data-testid={`card-product-${item.id}`}>
              <div className="h-48 bg-muted/30 flex items-center justify-center text-muted-foreground relative">
                {!item.isAvailable && (
                  <div className="absolute top-2 right-2 bg-destructive text-destructive-foreground text-[10px] uppercase font-bold px-2 py-0.5 rounded-sm">
                    Unavailable
                  </div>
                )}
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover mix-blend-multiply" />
                ) : (
                  <span className="text-xs uppercase tracking-widest font-mono">No image</span>
                )}
              </div>
              <CardContent className="p-4 flex-1">
                <div className="text-[10px] text-muted-foreground mb-1 font-mono uppercase tracking-wider">{item.category}</div>
                <h3 className="font-semibold text-base leading-tight mb-2 truncate" title={item.name}>{item.name}</h3>
                <div className="text-lg font-light">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
              </CardContent>
              <CardFooter className="p-4 pt-0 border-t border-border/20 mt-4 bg-muted/5">
                <Link href={`/catalog/${item.id}`} className="w-full" data-testid={`link-product-${item.id}`}>
                  <Button variant="secondary" className="w-full rounded-sm text-xs h-8 font-medium">View Details</Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
          {data?.items?.length === 0 && (
            <div className="col-span-full py-20 text-center text-muted-foreground border border-dashed border-border rounded-sm">
              No products found matching your criteria.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
