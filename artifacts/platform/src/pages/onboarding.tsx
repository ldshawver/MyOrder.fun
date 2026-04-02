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

const schema = z.object({
  companyName: z.string().min(2, "Company name is required"),
  contactName: z.string().min(2, "Contact name is required"),
  contactEmail: z.string().email("Invalid email address"),
  contactPhone: z.string().optional(),
  businessType: z.string().min(2, "Business type is required"),
  website: z.string().optional(),
  description: z.string().optional(),
  expectedOrderVolume: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export default function Onboarding() {
  const [submitted, setSubmitted] = useState(false);
  const submitRequest = useSubmitOnboardingRequest();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      companyName: "",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      businessType: "",
      website: "",
      description: "",
      expectedOrderVolume: "",
    },
  });

  const onSubmit = (data: FormValues) => {
    submitRequest.mutate({ data }, {
      onSuccess: () => {
        setSubmitted(true);
      }
    });
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-card p-8 border border-border shadow-sm rounded-lg text-center" data-testid="container-success">
          <h2 className="text-2xl font-bold mb-4" data-testid="text-success-title">Application Submitted</h2>
          <p className="text-muted-foreground mb-6" data-testid="text-success-message">
            Thank you for applying for an OrderFlow tenant account. Our team will review your application and be in touch shortly.
          </p>
          <Link href="/" className="text-primary hover:underline font-medium" data-testid="link-return-home">
            Return to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background py-12 px-4 flex flex-col items-center">
      <div className="max-w-2xl w-full">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Request Access</h1>
          <p className="text-muted-foreground" data-testid="text-subtitle">Apply for your organization's OrderFlow tenant.</p>
        </div>

        <div className="bg-card border border-border p-8 rounded-sm shadow-sm" data-testid="container-form">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="companyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Acme Corp" data-testid="input-company-name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="website"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Website</FormLabel>
                      <FormControl>
                        <Input placeholder="https://acme.com" data-testid="input-website" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contactName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Jane Doe" data-testid="input-contact-name" {...field} />
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
                      <FormLabel>Contact Email *</FormLabel>
                      <FormControl>
                        <Input placeholder="jane@example.com" type="email" data-testid="input-contact-email" {...field} />
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
                      <FormLabel>Contact Phone</FormLabel>
                      <FormControl>
                        <Input placeholder="+1 (555) 000-0000" data-testid="input-contact-phone" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="businessType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Business Type *</FormLabel>
                      <FormControl>
                        <Input placeholder="Wholesale, Retail..." data-testid="input-business-type" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="expectedOrderVolume"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Expected Monthly Volume</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. $50,000 / 1,000 orders" data-testid="input-expected-volume" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Additional Context</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Tell us about your use case" className="resize-none h-24" data-testid="input-description" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-4 border-t border-border flex justify-end">
                <Button type="submit" size="lg" disabled={submitRequest.isPending} data-testid="button-submit">
                  {submitRequest.isPending ? "Submitting..." : "Submit Application"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
