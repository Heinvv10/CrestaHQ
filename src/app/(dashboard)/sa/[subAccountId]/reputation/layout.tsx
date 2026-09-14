import { ReputationTabs } from "@/components/reputation/reputation-tabs";

/**
 * Reputation (SP5): Overview · Reviews · Requests · Widgets. The tabs render once here so
 * switching tabs re-renders only the page body.
 */
export default function ReputationLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-background/95 backdrop-blur md:-mx-6 md:-mt-6">
        <ReputationTabs />
      </div>
      <div className="flex-1 pt-8">{children}</div>
    </div>
  );
}
