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
import ConfirmationStep from "./confirmation";

const steps = [
  { label: "Payment Details" },
  { label: "Customer Information" },
  { label: "Confirmation" },
];

const STORAGE_KEY_PREFIX = 'paymentSessionData_';
const EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const initialPaymentState = {
  amount: "",
  referenceCode: "",
  customerName: "",
  customerEmail: "",
  customerPhone: "",
};

const PaymentPage = () => {
  const { merchantId } = useParams();
  const [newPayment, setNewPayment] = useState(initialPaymentState);
  const [paymentCode, setPaymentCode] = useState("");
  const [merchantDetails, setMerchantDetails] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [sessionActive, setSessionActive] = useState(false);

  const storageKey = `${STORAGE_KEY_PREFIX}${merchantId}`;

  useEffect(() => {
    const fetchMerchantDetails = async () => {
      try {
        const { data: merchantData, error: merchantError } = await supabase
          .from('merchants')
          .select('*')
          .eq('id', merchantId)
          .single();

        if (merchantError) throw merchantError;
        if (merchantData) {
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('avatar_url')
            .eq('id', merchantData.profile_id)
            .single();

          if (profileError) throw profileError;

          setMerchantDetails({
            ...merchantData,
            avatarUrl: profileData?.avatar_url,
          });
        }
      } catch (error) {
        console.error("Error fetching merchant details:", error);
      }
    };

    if (merchantId) {
      fetchMerchantDetails();
      loadSessionData();
    }
  }, [merchantId]);

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
          // If expired, remove the stored data
          localStorage.removeItem(storageKey);
        }
      } catch (error) {
        console.error("Error parsing stored data:", error);
        localStorage.removeItem(storageKey);
      }
    }
  };

  useEffect(() => {
    // Save session data to localStorage
    if (sessionActive) {
      const dataToStore = {
        newPayment,
        currentStep,
        timestamp: new Date().getTime(),
      };
      localStorage.setItem(storageKey, JSON.stringify({ data: dataToStore, timestamp: new Date().getTime() }));
    }
  }, [newPayment, currentStep, sessionActive, storageKey]);

  const generatePaymentCode = () => {
    const code = "PAY-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    setPaymentCode(code);
  };

  const resetSession = () => {
    setNewPayment(initialPaymentState);
    setCurrentStep(0);
    setSessionActive(false);
    localStorage.removeItem(storageKey);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <header className="bg-gray-800 p-4 shadow-md">
        <div className="container mx-auto flex justify-between items-center">
          <h1 className="text-2xl font-bold text-indigo-300">
            {merchantDetails ? merchantDetails.name : "Loading..."}
          </h1>
          <div className="flex items-center space-x-4">
            {sessionActive && (
              <Button 
                onClick={resetSession}
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                New Payment
              </Button>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-gray-400 hover:text-indigo-300 transition-colors">
                    <Info className="w-6 h-6" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="bg-gray-700 text-gray-100">
                  <p>Pay through your banking app. Choose PayShap.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {merchantDetails && (
              <Avatar>
                <AvatarImage src={merchantDetails.avatarUrl} alt={merchantDetails.name} />
                <AvatarFallback>{merchantDetails.name.charAt(0)}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>
      </header>

      <main className="flex-grow container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {sessionActive && (
            <div className="mb-4 p-2 bg-blue-600 text-white rounded">
              Session active - You can resume your previous payment
            </div>
          )}
          <Stepper initialStep={currentStep} steps={steps}>
            {steps.map((stepProps, index) => (
              <Step key={stepProps.label} {...stepProps}>
                <div className="bg-gray-800 rounded-lg shadow-lg p-6 my-6 border border-gray-700">
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
                    <ConfirmationStep phoneNumber="741879351" paymentCode={paymentCode} />
                  )}
                </div>
              </Step>
            ))}
            <StepperFooter 
              newPayment={newPayment} 
              generatePaymentCode={generatePaymentCode} 
              setCurrentStep={setCurrentStep}
              setSessionActive={setSessionActive}
            />
          </Stepper>
        </div>
      </main>
    </div>
  );
};

const StepperFooter = ({ newPayment, generatePaymentCode, setCurrentStep, setSessionActive }) => {
  const {
    nextStep,
    prevStep,
    isDisabledStep,
    hasCompletedAllSteps,
    isLastStep,
    activeStep,
  } = useStepper();

  const handleNext = () => {
    if (isLastStep) {
      generatePaymentCode();
    }
    nextStep();
    setCurrentStep(activeStep + 1);
    setSessionActive(true);
  };

  const handlePrev = () => {
    prevStep();
    setCurrentStep(activeStep - 1);
  };

  const isAmount = newPayment && !!newPayment.amount;

  return (
    <>
      {hasCompletedAllSteps && (
        <div className="h-40 flex items-center justify-center my-2 border border-green-600 bg-green-900 text-green-100 rounded-md">
          <h1 className="text-xl">Payment Completed Successfully! 🎉</h1>
        </div>
      )}
      <div className="w-full flex justify-end gap-2">
        {!hasCompletedAllSteps && (
          <>
            <Button
              disabled={isDisabledStep}
              onClick={handlePrev}
              size="sm"
              className="bg-gray-700 hover:bg-gray-600 text-gray-100"
            >
              Previous
            </Button>
            {isAmount &&
              <Button size="sm" onClick={handleNext} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                {isLastStep ? "Complete Payment" : "Next"}
              </Button>
            }
          </>
        )}
      </div>
    </>
  );
};

export default PaymentPage;