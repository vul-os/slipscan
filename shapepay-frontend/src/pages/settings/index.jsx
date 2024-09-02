import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from "@/components/ui/use-toast";
import MerchantHeader from './merchant-header';
import UserManagementTable from './user-management-table';
import PendingInvitationsTable from './pending-invitations-table';
import PaymentPageQR from './payment-page-qr';
import { InviteUserDialog, EditUserDialog, DeleteUserDialog, DeleteInvitationDialog } from './dialogs';

const SettingsPage = () => {
  const { user, activeMerchantId } = useContext(AuthContext);
  const [merchant, setMerchant] = useState({ id: '', name: '', email: '', phone: '', handle: '' });
  const [users, setUsers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { toast } = useToast();

  // Dialog states
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [editUserDialogOpen, setEditUserDialogOpen] = useState(false);
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [deleteInvitationDialogOpen, setDeleteInvitationDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);
  const [invitationToDelete, setInvitationToDelete] = useState(null);

  useEffect(() => {
    if (user) {
      fetchMerchantUsersAndInvitations();
    }
  }, [user]);

  const fetchMerchantUsersAndInvitations = async () => {
    try {
      setLoading(true);
      // Fetch merchant details
      const { data: md, error: me } = await supabase
        .from('merchants')
        .select('*')
        .eq('id', activeMerchantId)
        .single();

      if (me) throw me;
      setMerchant(md);

      // Fetch users
      const { data: userMerchantData, error: userMerchantError } = await supabase
        .from('merchant_users')
        .select(`
          user_id,
          profiles:user_id (email),
          roles:role_id (name)
        `)
        .eq('merchant_id', activeMerchantId);
  
      if (userMerchantError) throw userMerchantError;
  
      if (userMerchantData.length > 0) {
        const usersWithRoles = userMerchantData.map(user => ({
          user_id: user?.user_id,
          email: user.profiles ? user.profiles?.email : 'No Email',
          role_name: user.roles ? user.roles?.name : 'Unknown Role',
        }));
  
        setUsers(usersWithRoles);
      }

      // Fetch invitations
      const { data: invitationsData, error: invitationsError } = await supabase
        .from('merchant_invitations')
        .select('email, role_name')
        .eq('merchant_id', activeMerchantId);

      if (invitationsError) throw invitationsError;

      setInvitations(invitationsData);

    } catch (error) {
      console.error('Error fetching data:', error);
      setError('Failed to fetch information');
      toast({
        title: "Error",
        description: "Failed to fetch information",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleInviteUser = async (inviteEmail, inviteRole) => {
    try {
      setLoading(true);
      const { error } = await supabase.functions.invoke('invite-merchant', {
        body: { inviteeEmail: inviteEmail, merchantId: merchant.id, roleName: inviteRole }
      });

      if (error) throw error;
      toast({
        title: "Success",
        description: "Invitation sent successfully!",
        duration: 3000,
      });
      setInviteDialogOpen(false);
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error inviting user:', error);
      toast({
        title: "Error",
        description: "Error sending invitation",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleChangeRole = async (userId, newRole) => {
    try {
      setLoading(true);
      const { data: roleData } = await supabase
        .from('roles')
        .select('id')
        .eq('name', newRole)
        .single();

      const { error } = await supabase
        .from('merchant_users')
        .update({ role_id: roleData.id })
        .eq('user_id', userId)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "User role updated successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error updating user role:', error);
      toast({
        title: "Error",
        description: "Error updating user role",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchant_users')
        .delete()
        .eq('user_id', userToDelete)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "User removed successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error removing user:', error);
      toast({
        title: "Error",
        description: "Error removing user",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
      setDeleteUserDialogOpen(false);
      setUserToDelete(null);
    }
  };

  const handleRemoveInvitation = async () => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchant_invitations')
        .delete()
        .eq('email', invitationToDelete)
        .eq('merchant_id', merchant.id);

      if (error) throw error;
      toast({
        title: "Success",
        description: "Invitation removed successfully!",
        duration: 3000,
      });
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error removing invitation:', error);
      toast({
        title: "Error",
        description: "Error removing invitation",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
      setDeleteInvitationDialogOpen(false);
      setInvitationToDelete(null);
    }
  };

  const handleEditUser = async (updatedUser) => {
    try {
      setLoading(true);
      const { data: roleData } = await supabase
        .from('roles')
        .select('id')
        .eq('name', updatedUser.role_name)
        .single();

      const { error } = await supabase
        .from('merchant_users')
        .update({ role_id: roleData.id })
        .eq('user_id', updatedUser.user_id)
        .eq('merchant_id', merchant.id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "User updated successfully!",
        duration: 3000,
      });
      setEditUserDialogOpen(false);
      fetchMerchantUsersAndInvitations();
    } catch (error) {
      console.error('Error updating user:', error);
      toast({
        title: "Error",
        description: "Error updating user",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMerchantName = async (newName) => {
    try {
      setLoading(true);
      const { error } = await supabase
        .from('merchants')
        .update({ name: newName })
        .eq('id', merchant.id);

      if (error) throw error;

      setMerchant(prev => ({ ...prev, name: newName }));
      toast({
        title: "Success",
        description: "Merchant name updated successfully!",
        duration: 3000,
      });
    } catch (error) {
      console.error('Error updating merchant name:', error);
      toast({
        title: "Error",
        description: "Error updating merchant name",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center text-gray-300">Loading...</div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto px-2 sm:px-4 py-4">
        <div className="flex items-center space-x-2 mb-4">
          <Link to="/" className="text-blue-400 hover:text-blue-300 flex items-center">
            <Home className="w-4 h-4 mr-1" />
            Home
          </Link>
          <span>/</span>
          <span className="flex items-center">Settings</span>
        </div>

        <div className="space-y-6">
          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Merchant Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <MerchantHeader 
                merchant={merchant}
                onUpdateName={handleUpdateMerchantName}
                onInviteUser={() => setInviteDialogOpen(true)}
              />

              <UserManagementTable 
                users={users}
                onChangeRole={handleChangeRole}
                onEditUser={(user) => {
                  setCurrentUser(user);
                  setEditUserDialogOpen(true);
                }}
                onDeleteUser={(userId) => {
                  setUserToDelete(userId);
                  setDeleteUserDialogOpen(true);
                }}
              />

              <PendingInvitationsTable 
                invitations={invitations}
                onRemoveInvitation={(email) => {
                  setInvitationToDelete(email);
                  setDeleteInvitationDialogOpen(true);
                }}
              />
            </CardContent>
          </Card>

          <PaymentPageQR merchant={merchant} />
        </div>
      </div>

      <InviteUserDialog 
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        onInvite={handleInviteUser}
        loading={loading}
      />
      <EditUserDialog 
        open={editUserDialogOpen}
        onOpenChange={setEditUserDialogOpen}
        currentUser={currentUser}
        onEdit={handleEditUser}
        loading={loading}
      />
      <DeleteUserDialog 
        open={deleteUserDialogOpen}
        onOpenChange={setDeleteUserDialogOpen}
        onDelete={handleDeleteUser}
        loading={loading}
      />
      <DeleteInvitationDialog 
        open={deleteInvitationDialogOpen}
        onOpenChange={setDeleteInvitationDialogOpen}
        onDelete={handleRemoveInvitation}
        loading={loading}
      />
    </div>
  );
};

export default SettingsPage;