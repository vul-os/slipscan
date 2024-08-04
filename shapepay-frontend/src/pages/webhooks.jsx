import React, { useState, useEffect, useContext } from 'react';
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { Webhook } from 'lucide-react'
import AuthContext from '../context/auth-context';
import { supabase } from '../services/supabaseClient';

const Webhooks = () => {
  const [webhooks, setWebhooks] = useState([]);
  const [open, setOpen] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookEventType, setNewWebhookEventType] = useState('');
  const [merchantId, setMerchantId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user } = useContext(AuthContext);

  const eventTypes = ['payment.successful', 'payment.failed', 'refund.successful', 'payout.created'];

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    }
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchWebhooks();
    }
  }, [merchantId]);

  const fetchMerchantId = async () => {
    const { data, error } = await supabase
      .from('merchants')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (error) {
      console.error('Error fetching merchant ID:', error);
      setError('Failed to fetch merchant information.');
    } else {
      setMerchantId(data.id);
    }
    setLoading(false);
  };

  const fetchWebhooks = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('webhooks')
      .select('*')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching webhooks:', error);
      setError('Failed to fetch webhooks.');
    } else {
      setWebhooks(data);
    }
    setLoading(false);
  };

  const handleCreateWebhook = async () => {
    const { data, error } = await supabase
      .from('webhooks')
      .insert({
        merchant_id: merchantId,
        url: newWebhookUrl,
        event_type: newWebhookEventType,
        is_active: true
      });

    if (error) {
      console.error('Error creating new webhook:', error);
      setError('Failed to create webhook.');
    } else {
      fetchWebhooks();
      setOpen(false);
      setNewWebhookUrl('');
      setNewWebhookEventType('');
    }
  };

  const handleToggleWebhook = async (id, currentStatus) => {
    const { error } = await supabase
      .from('webhooks')
      .update({ is_active: !currentStatus })
      .eq('id', id)
      .eq('merchant_id', merchantId);

    if (error) {
      console.error('Error toggling webhook status:', error);
      setError('Failed to update webhook status.');
    } else {
      fetchWebhooks();
    }
  };

  const handleDeleteWebhook = async (id) => {
    const { error } = await supabase
      .from('webhooks')
      .delete()
      .eq('id', id)
      .eq('merchant_id', merchantId);

    if (error) {
      console.error('Error deleting webhook:', error);
      setError('Failed to delete webhook.');
    } else {
      fetchWebhooks();
    }
  };

  if (!user) {
    return (
      <Alert>
        <AlertTitle>Info</AlertTitle>
        <AlertDescription>
          Please log in to manage your webhooks.
        </AlertDescription>
      </Alert>
    );
  }

  if (loading) {
    return (
      <div className="w-full max-w-md mx-auto mt-8">
        <Progress value={33} className="w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col items-center p-6">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="mb-4">
            <Webhook className="mr-2 h-4 w-4" />
            Create New Webhook
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create New Webhook</DialogTitle>
            <DialogDescription>
              Enter the details for your new webhook here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="url" className="text-right">
                URL
              </Label>
              <Input
                id="url"
                value={newWebhookUrl}
                onChange={(e) => setNewWebhookUrl(e.target.value)}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="eventType" className="text-right">
                Event Type
              </Label>
              <Select
                value={newWebhookEventType}
                onValueChange={setNewWebhookEventType}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select an event type" />
                </SelectTrigger>
                <SelectContent>
                  {eventTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateWebhook}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>URL</TableHead>
            <TableHead>Event Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created At</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {webhooks.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.url}</TableCell>
              <TableCell>{row.event_type}</TableCell>
              <TableCell>
                <Switch
                  checked={row.is_active}
                  onCheckedChange={() => handleToggleWebhook(row.id, row.is_active)}
                />
              </TableCell>
              <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
              <TableCell>
                <Button variant="outline" size="sm" onClick={() => handleDeleteWebhook(row.id)}>
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default Webhooks;