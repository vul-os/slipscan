import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Step, Stepper, useStepper } from "@/components/stepper";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "../../../services/supabaseClient"
import PaymentDetailsStep from "./payment-details";
import CustomerInformationStep from "./customer-information";
import PaymentConfoirmationStep from "./confirmation";

const steps = [
  { label: "Payment" },
  { label: "Customer" },
  { label: "Confirm" },
  { label: "Complete" },
];

const STORAGE_KEY_PREFIX = 'paymentSessionData_';
const EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const initialPaymentState = {
  amount: "",
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  transactionCode: ""
};

const PaymentPage = () => {
  const { merchantHandle } = useParams();
  const [newPayment, setNewPayment] = useState(initialPaymentState);
  const [paymentDetails, setPaymentDetails] = useState(null);
  const [merchantDetails, setMerchantDetails] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [sessionActive, setSessionActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const storageKey = `${STORAGE_KEY_PREFIX}${merchantHandle}`;

  useEffect(() => {
    const fetchMerchantDetails = async () => {
      try {
        const { data, error } = await supabase
          .rpc('get_merchant', { p_merchant_handle: merchantHandle });

        if (error) throw error;
        if (data && data.length > 0) {
          setMerchantDetails({
            ...data[0],
            avatarUrl: "",
          });
        } else {
          throw new Error("Merchant not found");
        }
      } catch (error) {
        console.error("Error fetching merchant details:", error);
        setError("Failed to load merchant details. Please try again.");
      }
    };

    if (merchantHandle) {
      fetchMerchantDetails();
      loadSessionData();
    }
  }, [merchantHandle]);

  const loadSessionData = () => {
    const storedData = localStorage.getItem(storageKey);
    if (storedData) {
      try {
        const { data, timestamp } = JSON.parse(storedData);
        const now = new Date().getTime();
        if (now - timestamp < EXPIRATION_TIME) {
          setNewPayment(data.newPayment || initialPaymentState);
          setCurrentStep(data.currentStep || 0);
          setSessionActive(true);
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch (error) {
        console.error("Error parsing stored data:", error);
        localStorage.removeItem(storageKey);
      }
    }
  };

  useEffect(() => {
    if (sessionActive) {
      const dataToStore = {
        newPayment,
        currentStep,
        timestamp: new Date().getTime(),
      };
      localStorage.setItem(storageKey, JSON.stringify({ data: dataToStore, timestamp: new Date().getTime() }));
    }
  }, [newPayment, currentStep, sessionActive, storageKey]);

  const createSimplePayment = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc('create_simple_payment', {
        p_merchant_id: merchantDetails?.id,
        p_customer_name: newPayment?.customerName,
        p_customer_email: newPayment?.customerEmail,
        p_customer_phone: newPayment?.customerPhone,
        p_total_amount: 0, //parseFloat(newPayment.amount),
        p_currency: 'ZAR',
        p_payment_method: 'PayShap'
      });

      if (error) throw error;
      const d = data.length > 0 ? data[0] : data
      console.log(d)
      setPaymentDetails(d);
      return data;
    } catch (error) {
      console.error("Error creating payment:", error);
      setError("Failed to create payment. Please try again.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const resetSession = () => {
    setNewPayment(initialPaymentState);
    setCurrentStep(0);
    setSessionActive(false);
    setPaymentDetails(null);
    localStorage.removeItem(storageKey);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <header className="bg-gray-800 p-4 md:p-6 shadow-md">
        <div className="container mx-auto flex flex-col sm:flex-row justify-between items-center">
          <h1 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold text-indigo-300 mb-2 sm:mb-0">
            {merchantDetails ? merchantDetails.name : "Loading..."}
          </h1>
          <div className="flex items-center space-x-2 sm:space-x-4 md:space-x-6">
            {sessionActive && (
              <Button 
                onClick={resetSession}
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm md:text-base"
              >
                New Payment
              </Button>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-gray-400 hover:text-indigo-300 transition-colors">
                    <Info className="w-5 h-5 sm:w-6 sm:h-6 md:w-8 md:h-8" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="bg-gray-700 text-gray-100 text-sm md:text-base">
                  <p>Pay through your banking app. Choose PayShap.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {merchantDetails && (
              <Avatar className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12">
                <AvatarImage src={merchantDetails.avatarUrl} alt={merchantDetails.name} />
                <AvatarFallback>{merchantDetails.name.charAt(0)}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>
      </header>

      <main className="flex-grow container mx-auto px-4 py-6 sm:py-8 md:py-12 lg:py-16">
        <div className="max-w-lg md:max-w-xl lg:max-w-2xl mx-auto">
          {sessionActive && (
            <div className="mb-4 p-2 md:p-3 bg-blue-600 text-white rounded text-sm md:text-base">
              Resuming previous payment
            </div>
          )}
          {error && (
            <div className="mb-4 p-2 md:p-3 bg-red-600 text-white rounded text-sm md:text-base">
              {error}
            </div>
          )}
          <Stepper initialStep={currentStep} key={sessionActive ? 'active' : 'inactive'} steps={steps}>
            {steps.map((stepProps, index) => (
              <Step key={stepProps.label} {...stepProps}>
                <div className="bg-gray-800 rounded-lg shadow-lg p-4 sm:p-6 md:p-8 lg:p-10 my-4 sm:my-6 md:my-8 border border-gray-700">
                  {index === 0 && (
                    <PaymentDetailsStep
                      newPayment={newPayment}
                      setNewPayment={setNewPayment}
                      merchantDetails={merchantDetails}
                    />
                  )}
                  {index === 1 && (
                    <CustomerInformationStep
                      newPayment={newPayment}
                      setNewPayment={setNewPayment}
                    />
                  )}
                  {index === 2 && (
                    <PaymentConfoirmationStep 
                      paymentDetails={paymentDetails} 
                      newPayment={newPayment}
                    />
                  )}
                   {index === 3 && (
                    <CompletionStep 
                      paymentDetails={paymentDetails} 
                    />
                  )}
                </div>
              </Step>
            ))}
            <StepperFooter 
              newPayment={newPayment} 
              createSimplePayment={createSimplePayment}
              setCurrentStep={setCurrentStep}
              setSessionActive={setSessionActive}
              loading={loading}
              currentStep={currentStep}
              paymentDetails={paymentDetails}
            />
          </Stepper>
        </div>
      </main>
    </div>
  );
};

const CompletionStep = ({ paymentDetails }) => {
  return (
    <div className="h-32 sm:h-40 md:h-48 lg:h-56 flex items-center justify-center my-2 border border-green-600 bg-green-900 text-green-100 rounded-md">
      <h1 className="text-lg sm:text-xl md:text-2xl lg:text-3xl text-center px-4">Payment Completed Successfully! 🎉</h1>
    </div>
  );
};

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

export default PaymentPage;