/* eslint-disable */
/* tslint:disable */
// @ts-nocheck
/* prettier-ignore-start */
import React from "react";
import { classNames } from "@plasmicapp/react-web";

export type Icon5IconProps = React.ComponentProps<"svg"> & {
  title?: string;
};

export function Icon5Icon(props: Icon5IconProps) {
  const { className, style, title, ...restProps } = props;
  return (
    <svg
      xmlns={"http://www.w3.org/2000/svg"}
      fill={"none"}
      viewBox={"0 0 24 24"}
      height={"1em"}
      width={"1em"}
      className={classNames("plasmic-default__svg", className)}
      style={style}
      {...restProps}
    >
      {title && <title>{title}</title>}

      <path
        stroke={"currentColor"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
        strokeWidth={"1.5"}
        d={
          "M9.75 6.75h-3a2 2 0 00-2 2v8.5a2 2 0 002 2h6.5a2 2 0 002-2v-5m-5.5-5.5l5.5 5.5m-5.5-5.5v3.5a2 2 0 002 2h3.5m-3.5-7.5h2l5.5 5.5v5a2 2 0 01-2 2H15.5"
        }
      ></path>
    </svg>
  );
}

export default Icon5Icon;
/* prettier-ignore-end */
