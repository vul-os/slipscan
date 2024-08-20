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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Webhook, Home, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AuthContext } from '../context/use-auth';
import { supabase } from '../services/supabaseClient';

const WebhooksPage = () => {
  const [webhooks, setWebhooks] = useState([]);
  const [open, setOpen] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookEventType, setNewWebhookEventType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user, activeMerchantId } = useContext(AuthContext);

  const eventTypes = ['payment.successful', 'payment.failed', 'refund.successful', 'payout.created'];

  useEffect(() => {
    if (user && activeMerchantId) {
      fetchWebhooks();
    }
  }, [user, activeMerchantId]);

  const fetchWebhooks = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .eq('merchant_id', activeMerchantId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setWebhooks(data);
    } catch (error) {
      console.error('Error fetching webhooks:', error);
      setError('Failed to fetch webhooks. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWebhook = async () => {
    if (!newWebhookUrl || !newWebhookEventType) {
      setError('Please fill in all fields.');
      return;
    }
    setError(null);
    try {
      const { error } = await supabase
        .from('webhooks')
        .insert({
          merchant_id: activeMerchantId,
          url: newWebhookUrl,
          event_type: newWebhookEventType,
          is_active: true
        });

      if (error) throw error;
      fetchWebhooks();
      setOpen(false);
      setNewWebhookUrl('');
      setNewWebhookEventType('');
    } catch (error) {
      console.error('Error creating new webhook:', error);
      setError('Failed to create webhook. Please try again.');
    }
  };

  const handleToggleWebhook = async (id, currentStatus) => {
    setError(null);
    try {
      const { error } = await supabase
        .from('webhooks')
        .update({ is_active: !currentStatus })
        .eq('id', id)
        .eq('merchant_id', activeMerchantId);

      if (error) throw error;
      fetchWebhooks();
    } catch (error) {
      console.error('Error toggling webhook status:', error);
      setError('Failed to update webhook status. Please try again.');
    }
  };

  const handleDeleteWebhook = async (id) => {
    setError(null);
    try {
      const { error } = await supabase
        .from('webhooks')
        .delete()
        .eq('id', id)
        .eq('merchant_id', activeMerchantId);

      if (error) throw error;
      fetchWebhooks();
    } catch (error) {
      console.error('Error deleting webhook:', error);
      setError('Failed to delete webhook. Please try again.');
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <Alert>
          <AlertTitle>Info</AlertTitle>
          <AlertDescription>
            Please log in to manage your webhooks.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <div className="w-full max-w-md mx-auto">
          <Progress value={33} className="w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto px-2 sm:px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <Link to="/" className="text-blue-400 hover:text-blue-300 flex items-center">
              <Home className="w-4 h-4 mr-1" />
              Home
            </Link>
            <span>/</span>
            <span className="flex items-center">
              <Webhook className="w-4 h-4 mr-1" />
              Webhooks
            </span>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-blue-500 hover:bg-blue-600">
                <Plus className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">New Webhook</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-gray-800 text-gray-100">
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
                    className="col-span-3 bg-gray-700 text-gray-100"
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
                    <SelectTrigger className="col-span-3 bg-gray-700 text-gray-100">
                      <SelectValue placeholder="Select an event type" />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-700 text-gray-100">
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
                <Button onClick={handleCreateWebhook} className="bg-blue-500 hover:bg-blue-600">Create</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="space-y-6">
          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Webhooks Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-300">Manage your webhooks here. You can create, activate, deactivate, and delete webhooks as needed.</p>
            </CardContent>
          </Card>

          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Your Webhooks</CardTitle>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {webhooks.length === 0 ? (
                <p className="text-gray-300">No webhooks found. Create a new webhook to get started.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-b border-gray-700">
                        <TableHead className="text-gray-300">URL</TableHead>
                        <TableHead className="text-gray-300">Event Type</TableHead>
                        <TableHead className="text-gray-300">Status</TableHead>
                        <TableHead className="text-gray-300">Created At</TableHead>
                        <TableHead className="text-gray-300">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {webhooks.map((row) => (
                        <TableRow key={row.id} className="border-b border-gray-700">
                          <TableCell className="text-gray-300">{row.url}</TableCell>
                          <TableCell className="text-gray-300">{row.event_type}</TableCell>
                          <TableCell>
                            <Switch
                              checked={row.is_active}
                              onCheckedChange={() => handleToggleWebhook(row.id, row.is_active)}
                            />
                          </TableCell>
                          <TableCell className="text-gray-300">{new Date(row.created_at).toLocaleString()}</TableCell>
                          <TableCell>
                            <Button variant="destructive" size="sm" onClick={() => handleDeleteWebhook(row.id)}>
                              Delete
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default WebhooksPage;