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
  { label: "Payment Details" },
  { label: "Customer Information" },
  { label: "Payment Information" },
  { label: "Completion" },

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
  const { merchantId } = useParams();
  const [newPayment, setNewPayment] = useState(initialPaymentState);
  const [paymentDetails, setPaymentDetails] = useState(null);
  const [merchantDetails, setMerchantDetails] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [sessionActive, setSessionActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
          setMerchantDetails({
            ...merchantData,
            avatarUrl: "",
          });
        }
      } catch (error) {
        console.error("Error fetching merchant details:", error);
        setError("Failed to load merchant details. Please try again.");
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
        p_merchant_id: merchantId,
        p_customer_name: newPayment.customerName,
        p_customer_email: newPayment.customerEmail,
        p_customer_phone: newPayment.customerPhone,
        p_total_amount: parseFloat(newPayment.amount),
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
          {error && (
            <div className="mb-4 p-2 bg-red-600 text-white rounded">
              {error}
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
            />
          </Stepper>
        </div>
      </main>
    </div>
  );
};

const CompletionStep = ({ paymentDetails }) => {
  return (
    <div className="h-40 flex items-center justify-center my-2 border border-green-600 bg-green-900 text-green-100 rounded-md">
      <h1 className="text-xl">Payment Completed Successfully! 🎉</h1>
      {/* Add more details from paymentDetails if needed */}
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
    console.log(activeStep)
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

  const isFormValid = newPayment && !!newPayment.amount 
  const isLastStepValid = currentStep === 1 && paymentDetails

  return (
    <>
      <div className="w-full flex justify-end gap-2">       
          <>
            <Button
              disabled={isDisabledStep || loading}
              onClick={handlePrev}
              size="sm"
              className="bg-gray-700 hover:bg-gray-600 text-gray-100"
            >
              Previous
            </Button>
            {(isFormValid || isLastStepValid) && !isLastStep && (
              <Button 
                size="sm" 
                onClick={handleNext} 
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
                disabled={loading}
              >
                {loading ? "Processing..." : "Next"}
              </Button>
            )}
          </>
        
      </div>
    </>
  );
};

export default PaymentPage;