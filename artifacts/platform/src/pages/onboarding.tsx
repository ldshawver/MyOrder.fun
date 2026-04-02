import { useState } from "react";
import { Link } from "wouter";
import { useSubmitOnboardingRequest } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Lock } from "lucide-react";

const schema = z.object({
  contactName: z.string().min(2, "Name is required"),
  contactEmail: z.string().email("Invalid email address"),
  contactPhone: z.string().optional(),
  description: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export default function Onboarding() {
  const [submitted, setSubmitted] = useState(false);
  const submitRequest = useSubmitOnboardingRequest();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      description: "",
    },
  });

  const onSubmit = (data: FormValues) => {
    submitRequest.mutate({
      data: {
        ...data,
        companyName: data.contactName,
        businessType: "private",
        expectedOrderVolume: "",
      }
    }, {
      onSuccess: () => setSubmitted(true),
    });
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4" style={{ background: "#040810" }}>
        <div className="max-w-md w-full glass-card rounded-2xl p-10 text-center border border-primary/20" data-testid="container-success">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-5">
            <Lock size={24} className="text-primary" />
          </div>
          <h2 className="text-xl font-bold mb-3" data-testid="text-success-title">Access Requested</h2>
          <p className="text-muted-foreground text-sm leading-relaxed mb-6" data-testid="text-success-message">
            Your invitation request has been received. Our team will review and reach out to you directly.
          </p>
          <Link href="/" className="text-primary hover:underline font-medium text-sm" data-testid="link-return-home">
            Return
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4 flex flex-col items-center justify-center" style={{ background: "#040810" }}>
      <div className="max-w-lg w-full">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold tracking-widest uppercase mb-5">
            <Lock size={11} />
            Invitation Only
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2" data-testid="text-title">Request Access</h1>
          <p className="text-muted-foreground text-sm" data-testid="text-subtitle">
            Submit your details and we'll reach out with your invitation.
          </p>
        </div>

        <div className="glass-card rounded-2xl p-8 border border-border/40" data-testid="container-form">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField
                control={form.control}
                name="contactName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Full Name *</FormLabel>
                    <FormControl>
                      <Input placeholder="Your name" className="rounded-xl h-11 bg-background/50" data-testid="input-contact-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Email *</FormLabel>
                    <FormControl>
                      <Input placeholder="you@example.com" type="email" className="rounded-xl h-11 bg-background/50" data-testid="input-contact-email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="+1 (555) 000-0000" className="rounded-xl h-11 bg-background/50" data-testid="input-contact-phone" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Message <span className="normal-case font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="How can we help you?"
                        className="resize-none h-24 rounded-xl bg-background/50"
                        data-testid="input-description"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="pt-2">
                <Button
                  type="submit"
                  className="w-full rounded-xl h-11 font-semibold shadow-lg shadow-primary/20"
                  disabled={submitRequest.isPending}
                  data-testid="button-submit"
                >
                  {submitRequest.isPending ? "Submitting..." : "Submit Request"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
