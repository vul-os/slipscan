import { useStepper } from "@/components/stepper";
import { Button } from "@/components/ui/button";

const StepperFooter = ({ 
    newPayment, 
    createSimplePayment, 
    setCurrentStep, 
    setSessionActive, 
    loading, 
    currentStep,
    paymentDetails
  }) => {
    const {
      nextStep,
      prevStep,
      isDisabledStep,
      hasCompletedAllSteps,
      isLastStep,
      activeStep,
    } = useStepper();
  
    const handleNext = async () => {
      if (activeStep === 1) {
        const paymentResult = await createSimplePayment();
        if (paymentResult) {
          nextStep();
          setCurrentStep(activeStep + 1);
        }
      } else {
        nextStep();
        setCurrentStep(activeStep + 1);
      }
      setSessionActive(true);
    };
  
    const handlePrev = () => {
      prevStep();
      setCurrentStep(activeStep - 1);
    };
  
    const isFormValid = true;
    const isLastStepValid = currentStep === 1 && paymentDetails;
  
    return (
      <div className="w-full flex justify-end gap-2 md:gap-4 mt-4 md:mt-6">       
        <Button
          disabled={isDisabledStep || loading}
          onClick={handlePrev}
          size="sm"
          className="bg-gray-700 hover:bg-gray-600 text-gray-100 text-xs sm:text-sm md:text-base px-4 py-2 md:px-6 md:py-3"
        >
          Previous
        </Button>
        {(isFormValid || isLastStepValid) && !isLastStep && (
          <Button 
            size="sm" 
            onClick={handleNext} 
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm md:text-base px-4 py-2 md:px-6 md:py-3"
            disabled={loading}
          >
            {loading ? "Processing..." : "Next"}
          </Button>
        )}
      </div>
    );
  };
  
  export default StepperFooter;