import React from 'react';
import { File, FileText, Image as ImageIcon } from 'lucide-react';

const FilePreview = ({ file, signedUrl }) => {
  const getFileIcon = () => {
    const contentType = file.content_type;
    const iconProps = {
      className: "h-12 w-12 text-blue-600",
      strokeWidth: 1.5
    };

    if (contentType.startsWith('image/')) {
      return <ImageIcon {...iconProps} />;
    } else if (contentType === 'application/pdf') {
      return <FileText {...iconProps} />;
    } else {
      return <File {...iconProps} />;
    }
  };

  return (
    <div className="w-full aspect-square bg-gray-100 rounded-md overflow-hidden">
      <div className="relative w-full h-full">
        {signedUrl && file.content_type.startsWith('image/') ? (
          <img
            src={signedUrl}
            alt={file.file_name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              e.target.onerror = null;
              e.target.style.display = 'none';
              e.target.nextElementSibling.style.display = 'flex';
            }}
          />
        ) : null}
        <div className={`absolute inset-0 flex items-center justify-center ${signedUrl && file.content_type.startsWith('image/') ? 'hidden' : ''}`}>
          {getFileIcon()}
        </div>
      </div>
    </div>
  );
};

export default FilePreview;