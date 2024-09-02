import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Step, Stepper, useStepper } from "@/components/stepper";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info, CheckCircle, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "../../../services/supabaseClient"
import PaymentDetailsStep from "./payment-details";
import CustomerInformationStep from "./customer-information";
import PaymentConfoirmationStep from "./confirmation";
import StepperFooter from "./stepper-footer";
import CompletionStep from "./completion";

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
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [paymentAmount, setPaymentAmount] = useState(0);

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

  useEffect(() => {
    if (paymentDetails?.payment_group_id) {
      const fetchInitialStatus = async () => {
        const { data, error } = await supabase
          .from('payment_groups')
          .select('status, total_amount')
          .eq('id', paymentDetails.payment_group_id)
          .single();

        if (error) {
          console.error('Error fetching initial payment status:', error);
          return;
        }
        console.log(data)
        setPaymentStatus(data.status);
        setPaymentAmount(data.total_amount);
      };

      fetchInitialStatus();

      const subscription = supabase
        .channel(`payment_${paymentDetails.payment_group_id}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'payment_groups',
          filter: `id=eq.${paymentDetails.payment_group_id}`
        }, (payload) => {
          setPaymentStatus(payload.new.status);
          setPaymentAmount(payload.new.total_amount);
        })
        .subscribe();

      return () => {
        subscription.unsubscribe();
      };
    }
  }, [paymentDetails?.payment_group_id, supabase]);

  useEffect(() => {
    if (paymentStatus === "completed") {
      localStorage.removeItem(storageKey);
    }
  }, [paymentStatus]);

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
          setPaymentDetails(data.paymentDetails || null);
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
        paymentDetails,
        timestamp: new Date().getTime(),
      };
      localStorage.setItem(storageKey, JSON.stringify({ data: dataToStore, timestamp: new Date().getTime() }));
    }
  }, [newPayment, currentStep, sessionActive, storageKey, paymentDetails]);

  const createSimplePayment = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc('create_simple_payment', {
        p_merchant_id: merchantDetails?.id,
        p_customer_name: newPayment?.customerName,
        p_customer_email: newPayment?.customerEmail,
        p_customer_phone: newPayment?.customerPhone,
        p_total_amount: 0,
        p_currency: 'ZAR',
        p_payment_method: 'PayShap'
      });

      if (error) throw error;
      const d = data.length > 0 ? data[0] : data
      setPaymentDetails(d);
      setPaymentStatus(d.status);
      setPaymentAmount(d.total_amount);
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
    setPaymentStatus("pending");
    setPaymentAmount(0);
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
              Active Payment
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
                      paymentStatus={paymentStatus}
                      paymentAmount={paymentAmount}
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
              paymentStatus={paymentStatus}
            />
          </Stepper>
        </div>
      </main>
    </div>
  );
};

export default PaymentPage;