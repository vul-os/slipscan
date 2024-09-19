import React, { useEffect, useState, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import { AuthContext } from '../context/use-auth';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Trash2, FilePlus, Eye, Folder, FileText, FileImage, File } from 'lucide-react';
import FileUploadModal from './file-upload';

const DocumentList = () => {
  const [documents, setDocuments] = useState([]);
  const [sortBy, setSortBy] = useState('date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchDocuments();
    }
  }, [user, sortBy, sortOrder]);

  const fetchDocuments = async () => {
    const { data, error } = await supabase
      .from('documents')
      .select(`
        id,
        transaction_number,
        document_timestamp,
        document_files (id, bucket_name, file_path, file_name, content_type)
      `)
      .eq('user_id', user.id)
      .order(sortBy === 'name' ? 'transaction_number' : 'document_timestamp', { ascending: sortOrder === 'asc' });
     
    if (error) {
      console.error('Error fetching documents:', error);
    } else {
      setDocuments(data);
    }
  };

  const handleOpen = async (document) => {
    if (document.document_files && document.document_files[0]) {
      try {
        const { data, error } = await supabase.storage
          .from('snaps')
          .createSignedUrl(document.document_files[0].file_path, 60); // URL valid for 60 seconds

        if (error) throw error;

        window.open(data.signedUrl, '_blank');
      } catch (error) {
        console.error('Error creating signed URL:', error);
      }
    } else {
      console.error('No file associated with this document');
    }
  };

  const handleDelete = async (id) => {
    try {
      // Start a Supabase transaction
      const { error } = await supabase.rpc('delete_document_and_files', { doc_id: id });

      if (error) throw error;

      // If successful, refresh the documents list
      fetchDocuments();
    } catch (error) {
      console.error('Error deleting document and associated files:', error);
      // Handle the error appropriately (e.g., show an error message to the user)
    }
  };

  const getFileIcon = (contentType) => {
    const iconProps = {
      className: "h-16 w-16 text-blue-600", // Increased size and changed color to blue
      strokeWidth: 1.5 // Slightly thicker lines for better visibility
    };

    if (contentType.startsWith('image/')) {
      return <FileImage {...iconProps} />;
    } else if (contentType === 'application/pdf') {
      return <FileText {...iconProps} />;
    } else {
      return <File {...iconProps} />;
    }
  };

  const groupDocumentsBySession = () => {
    const groups = {};
    documents.forEach(doc => {
      const filePath = doc.document_files[0]?.file_path;
      if (filePath) {
        const [, sessionFolder] = filePath.split('/');
        if (!groups[sessionFolder]) {
          groups[sessionFolder] = [];
        }
        groups[sessionFolder].push(doc);
      }
    });
    return groups;
  };

  const documentGroups = groupDocumentsBySession();

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-2 sm:space-y-0">
          <span>My Documents</span>
          <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="date">Date</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort order" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setIsUploadModalOpen(true)}>
              <FilePlus className="mr-2 h-4 w-4" /> 
              Add New Documents
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible className="w-full">
          {Object.entries(documentGroups).map(([sessionFolder, docs]) => (
            <AccordionItem value={sessionFolder} key={sessionFolder}>
              <AccordionTrigger>
                <div className="flex items-center">
                  <Folder className="mr-2 h-4 w-4" />
                  <span>{formatSessionFolder(sessionFolder)}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {docs.map((doc) => (
                    <Card key={doc.id} className="flex flex-col">
                      <CardContent className="flex-grow p-4">
                        <div className="aspect-square mb-2 overflow-hidden rounded-md flex items-center justify-center bg-gray-100">
                          {doc.document_files && doc.document_files[0] ? 
                            getFileIcon(doc.document_files[0].content_type) :
                            <File className="h-12 w-12 text-gray-400" />
                          }
                        </div>
                        <h3 className="font-semibold truncate">{doc.transaction_number}</h3>
                        <p className="text-sm text-gray-500">
                          {new Date(doc.document_timestamp).toLocaleTimeString()}
                        </p>
                      </CardContent>
                      <div className="flex justify-end p-4 pt-0">
                        <Button variant="ghost" onClick={() => handleOpen(doc)}><Eye className="h-4 w-4" /></Button>
                        <Button variant="ghost" onClick={() => handleDelete(doc.id)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
      <FileUploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUploadComplete={fetchDocuments}
        userId={user.id}
      />
    </Card>
  );
};

const formatSessionFolder = (folder) => {
  const date = new Date(folder.slice(0, 4), folder.slice(4, 6) - 1, folder.slice(6, 8), 
                        folder.slice(9, 11), folder.slice(11, 13), folder.slice(13, 15));
  return date.toLocaleString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
};

export default DocumentList;