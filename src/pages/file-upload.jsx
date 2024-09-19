import React, { useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { X, Upload, FileIcon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import imageCompression from 'browser-image-compression';

const FileUploadModal = ({ isOpen, onClose, onUploadComplete, userId }) => {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleFileChange = (event) => {
    setFiles(Array.from(event.target.files));
  };

  const compressImage = async (file) => {
    const options = {
      maxSizeMB: 5,
      maxWidthOrHeight: 1920,
      useWebWorker: true,
    };

    try {
      const compressedFile = await imageCompression(file, options);
      return compressedFile;
    } catch (error) {
      console.error("Error compressing image:", error);
      return file;
    }
  };

  const handleUpload = async () => {
    setUploading(true);
    setProgress(0);

    const sessionFolder = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];

    for (let i = 0; i < files.length; i++) {
      let file = files[i];
      const fileExt = file.name.split('.').pop().toLowerCase();

      if (['jpg', 'jpeg', 'png'].includes(fileExt)) {
        file = await compressImage(file);
      }

      const fileName = `${uuidv4()}.${fileExt}`;
      const filePath = `${userId}/${sessionFolder}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('snaps')
        .upload(filePath, file);

      if (uploadError) {
        console.error('Error uploading file:', uploadError);
        continue;
      }

      const { data, error: insertError } = await supabase
        .from('documents')
        .insert({
          user_id: userId,
          transaction_number: file.name,
          document_timestamp: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error inserting document:', insertError);
        continue;
      }

      const { error: fileError } = await supabase
        .from('document_files')
        .insert({
          user_id: userId,
          document_id: data.id,
          bucket_name: 'slips',
          file_path: filePath,
          file_name: fileName,
          content_type: file.type,
          file_size: file.size,
        });

      if (fileError) {
        console.error('Error inserting document file:', fileError);
      }

      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setUploading(false);
    onUploadComplete();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Upload Documents</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 py-4">
          <div className="flex items-center gap-4">
            <label htmlFor="file-upload" className="cursor-pointer">
              <div className="flex items-center justify-center w-full h-32 px-4 transition bg-white border-2 border-gray-300 border-dashed rounded-md appearance-none hover:border-gray-400 focus:outline-none">
                <span className="flex items-center space-x-2">
                  <Upload className="w-6 h-6 text-gray-600" />
                  <span className="font-medium text-gray-600">
                    Click to upload or drag and drop
                  </span>
                </span>
                <input
                  id="file-upload"
                  name="file-upload"
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={handleFileChange}
                  accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                />
              </div>
            </label>
          </div>
          {uploading && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-gray-500">Uploading...</div>
              <Progress value={progress} className="w-full" />
            </div>
          )}
          <div className="max-h-[200px] overflow-y-auto space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-md">
                <div className="flex items-center space-x-2">
                  <FileIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-700 truncate max-w-[300px]">
                    {file.name}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                  disabled={uploading}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline" disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={uploading || files.length === 0}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FileUploadModal;