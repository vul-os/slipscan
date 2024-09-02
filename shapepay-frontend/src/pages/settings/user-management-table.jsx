import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Edit2, Trash2 } from 'lucide-react';

const UserManagementTable = ({ users, onChangeRole, onEditUser, onDeleteUser }) => {
  return (
    <Card className="bg-gray-800 border-gray-700 shadow-lg">
      <CardHeader>
        <CardTitle className="text-gray-100">User Management</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-gray-700">
              <TableHead className="text-gray-300">Email</TableHead>
              <TableHead className="text-gray-300">Role</TableHead>
              <TableHead className="text-right text-gray-300">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.user_id} className="border-b border-gray-700">
                <TableCell className="text-gray-300">{user?.email}</TableCell>
                <TableCell>
                  <Select
                    value={user.role_name}
                    onValueChange={(value) => onChangeRole(user.user_id, value)}
                  >
                    <SelectTrigger className="w-[120px] sm:w-[180px] bg-gray-700 text-gray-300 border-gray-600">
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-700 text-gray-300 border-gray-600">
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => onEditUser(user)} className="text-gray-300 hover:text-gray-100 p-1 sm:p-2">
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDeleteUser(user.user_id)} className="text-gray-300 hover:text-gray-100 p-1 sm:p-2">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

export default UserManagementTable;