import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Step {
  title: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <>
      {/* Mobile: compact "Step N of M" */}
      <div className="flex items-center justify-center text-sm text-muted-foreground sm:hidden">
        Step {currentStep + 1} of {steps.length}
        <span className="ml-2 font-medium text-foreground">
          {steps[currentStep]?.title}
        </span>
      </div>

      {/* Desktop: full step indicator */}
      <div className="hidden sm:flex items-center justify-center gap-0">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;

          return (
            <div key={index} className="flex items-center">
              {/* Connector line before (except first) */}
              {index > 0 && (
                <div
                  className={cn(
                    'h-0.5 w-8 md:w-12 transition-colors',
                    isCompleted ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}

              <div className="flex flex-col items-center gap-1.5">
                {/* Circle */}
                <div
                  className={cn(
                    'flex size-8 items-center justify-center rounded-full border-2 text-sm font-medium transition-all',
                    isCompleted &&
                      'border-primary bg-primary text-primary-foreground',
                    isCurrent &&
                      'border-primary text-primary animate-pulse',
                    !isCompleted &&
                      !isCurrent &&
                      'border-muted-foreground/30 text-muted-foreground/50',
                  )}
                >
                  {isCompleted ? (
                    <Check className="size-4" />
                  ) : (
                    index + 1
                  )}
                </div>

                {/* Title */}
                <span
                  className={cn(
                    'text-xs whitespace-nowrap',
                    isCurrent
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {step.title}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
