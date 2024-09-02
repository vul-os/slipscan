import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Trash2 } from 'lucide-react';

const PendingInvitationsTable = ({ invitations, onRemoveInvitation }) => {
  return (
    <Card className="bg-gray-800 border-gray-700 shadow-lg mt-6">
      <CardHeader>
        <CardTitle className="text-gray-100">Pending Invitations</CardTitle>
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
            {invitations.map((invitation, index) => (
              <TableRow key={index} className="border-b border-gray-700">
                <TableCell className="text-gray-300">{invitation.email}</TableCell>
                <TableCell className="text-gray-300">{invitation.role_name}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemoveInvitation(invitation.email)}
                    className="text-gray-300 hover:text-gray-100 p-1 sm:p-2"
                  >
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

export default PendingInvitationsTable;