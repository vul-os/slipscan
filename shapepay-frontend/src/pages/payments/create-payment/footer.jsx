import React from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useStepper } from "@/components/stepper";

// Footer Component
const Footer = ({ onSubmit }) => {
  const {
    nextStep,
    prevStep,
    resetSteps,
    hasCompletedAllSteps,
    isLastStep,
    isOptionalStep,
    isDisabledStep,
  } = useStepper();

  return (
    <DialogFooter className="flex justify-between items-center px-6 py-4 bg-gray-800 text-gray-100 rounded-b-lg shadow-lg">
      {hasCompletedAllSteps && (
        <div className="h-40 flex items-center justify-center my-2 border bg-gray-700 text-gray-100 rounded-md w-full">
          <h1 className="text-xl">Woohoo! All steps completed! 🎉</h1>
        </div>
      )}
      <div className="w-full flex justify-end gap-2">
        {hasCompletedAllSteps ? (
          <Button size="sm" onClick={resetSteps} className="bg-blue-600 hover:bg-blue-700 text-white">
            Reset
          </Button>
        ) : (
          <>
            <Button
              disabled={isDisabledStep}
              onClick={prevStep}
              size="sm"
              variant="secondary"
              className="bg-gray-600 hover:bg-gray-700 text-white"
            >
              Prev
            </Button>
            <Button
              size="sm"
              onClick={isLastStep ? onSubmit : nextStep}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isLastStep ? "Finish" : isOptionalStep ? "Skip" : "Next"}
            </Button>
          </>
        )}
      </div>
    </DialogFooter>
  );
};

export default Footer;
