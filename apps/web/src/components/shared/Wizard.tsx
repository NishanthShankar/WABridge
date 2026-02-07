import { useState, useCallback } from 'react';
import { StepIndicator } from './StepIndicator';
import { Button } from '@/components/ui/button';

export interface WizardStep {
  title: string;
  component: React.ReactNode;
  validate?: () => boolean | Promise<boolean>;
}

interface WizardProps {
  steps: WizardStep[];
  onComplete: () => void | Promise<void>;
  onCancel?: () => void;
  completeLabel?: string;
}

export function Wizard({
  steps,
  onComplete,
  onCancel,
  completeLabel = 'Complete',
}: WizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isValidating, setIsValidating] = useState(false);

  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;
  const step = steps[currentStep];

  const handleNext = useCallback(async () => {
    if (!step) return;

    if (step.validate) {
      setIsValidating(true);
      try {
        const valid = await step.validate();
        if (!valid) return;
      } finally {
        setIsValidating(false);
      }
    }

    if (isLast) {
      setIsValidating(true);
      try {
        await onComplete();
      } finally {
        setIsValidating(false);
      }
    } else {
      setCurrentStep((s) => s + 1);
    }
  }, [step, isLast, onComplete]);

  const handleBack = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto">
      <StepIndicator
        steps={steps.map((s) => ({ title: s.title }))}
        currentStep={currentStep}
      />

      {/* Step content */}
      <div className="min-h-[200px]">{step?.component}</div>

      {/* Navigation */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t">
        <div>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={isFirst}
          >
            Back
          </Button>
          <Button onClick={handleNext} disabled={isValidating}>
            {isValidating ? 'Please wait...' : isLast ? completeLabel : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}
