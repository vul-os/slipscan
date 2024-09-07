import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "../../../services/supabaseClient";
import PaymentConfirmation from "./confirmation";
import Completion from "./completion";

const STORAGE_KEY_PREFIX = 'paymentSessionData_';
const EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const PaymentPage = () => {
  const { merchantHandle } = useParams();
  const [merchantDetails, setMerchantDetails] = useState(null);
  const [paymentDetails, setPaymentDetails] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);

  const storageKey = `${STORAGE_KEY_PREFIX}${merchantHandle}`;

  useEffect(() => {
    const initializePaymentPage = async () => {
      setLoading(true);
      setError(null);
      try {
        await fetchMerchantDetails();
        const sessionLoaded = await loadSessionData();
        if (!sessionLoaded) {
          await createSimplePayment();
        }
      } catch (error) {
        console.error("Error initializing payment page:", error);
        setError("Failed to initialize payment. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    initializePaymentPage();
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
  }, [paymentDetails?.payment_group_id]);

  useEffect(() => {
    if (sessionActive && paymentDetails) {
      const dataToStore = {
        paymentDetails,
        timestamp: new Date().getTime(),
      };
      localStorage.setItem(storageKey, JSON.stringify(dataToStore));
    }
  }, [sessionActive, storageKey, paymentDetails]);

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
      throw new Error("Failed to load merchant details. Please try again.");
    }
  };

  const loadSessionData = async () => {
    const storedData = localStorage.getItem(storageKey);
    if (storedData) {
      try {
        const { paymentDetails, timestamp } = JSON.parse(storedData);
        const now = new Date().getTime();
        if (now - timestamp < EXPIRATION_TIME) {
          setPaymentDetails(paymentDetails || null);
          setSessionActive(true);
          return true;
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch (error) {
        console.error("Error parsing stored data:", error);
        localStorage.removeItem(storageKey);
      }
    }
    return false;
  };

  const createSimplePayment = async () => {
    if (!merchantDetails || !merchantDetails.id) {
      throw new Error("Merchant details not available");
    }

    try {
      const { data, error } = await supabase.rpc('create_simple_payment', {
        p_merchant_id: merchantDetails.id,
        p_customer_name: "",
        p_customer_email: "",
        p_customer_phone: "",
        p_total_amount: 0,
        p_currency: 'ZAR',
        p_payment_method: 'PayShap'
      });

      if (error) throw error;
      const d = data.length > 0 ? data[0] : data;
      setPaymentDetails(d);
      setPaymentStatus(d.status);
      setPaymentAmount(d.total_amount);
      setSessionActive(true);
      return d;
    } catch (error) {
      console.error("Error creating payment:", error);
      throw new Error("Failed to create payment. Please try again.");
    }
  };

  const resetSession = async () => {
    setLoading(true);
    setError(null);
    setPaymentDetails(null);
    setPaymentStatus("pending");
    setPaymentAmount(0);
    setSessionActive(false);
    localStorage.removeItem(storageKey);
    try {
      await createSimplePayment();
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <header className="bg-gray-800 p-4 shadow-md">
        <div className="container mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold text-indigo-300">
            {merchantDetails ? merchantDetails.name : "Loading..."}
          </h1>
          <div className="flex items-center space-x-2">
            {sessionActive && (
              <Button 
                onClick={resetSession}
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs"
              >
                New Payment
              </Button>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-gray-400 hover:text-indigo-300 transition-colors">
                    <Info className="w-5 h-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="bg-gray-700 text-gray-100 text-sm">
                  <p>Pay through your banking app. Choose PayShap.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {merchantDetails && (
              <Avatar className="w-8 h-8">
                <AvatarImage src={merchantDetails.avatarUrl} alt={merchantDetails.name} />
                <AvatarFallback>{merchantDetails.name.charAt(0)}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>
      </header>

      <main className="flex-grow container mx-auto px-4 py-6">
        <div className="max-w-md mx-auto">
          {sessionActive && (
            <div className="mb-4 p-2 bg-blue-600 text-white rounded text-sm">
              Active Payment Session
            </div>
          )}
          {error && (
            <div className="mb-4 p-2 bg-red-600 text-white rounded text-sm">
              {error}
            </div>
          )}
          {loading ? (
            <div className="text-center">Loading...</div>
          ) : (
            <>
              <div className="bg-gray-800 rounded-lg shadow-lg p-4 my-4 border border-gray-700">
                <PaymentConfirmation
                  paymentDetails={paymentDetails} 
                />
              </div>
              <div className="bg-gray-800 rounded-lg shadow-lg p-4 my-4 border border-gray-700">
                <Completion
                  paymentDetails={paymentDetails}
                  paymentStatus={paymentStatus}
                  paymentAmount={paymentAmount}
                />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default PaymentPage;