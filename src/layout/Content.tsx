import React from 'react';

const Content = (props: { children: any }) => {
  return (
    <div
      className="page-content"
      style={{
        width: '100%',
        height: '100%',
      }}
    >
      {props.children}
    </div>
  );
};

export default Content;
