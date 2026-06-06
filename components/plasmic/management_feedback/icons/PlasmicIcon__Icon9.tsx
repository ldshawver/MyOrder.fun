/* eslint-disable */
/* tslint:disable */
// @ts-nocheck
/* prettier-ignore-start */
import React from "react";
import { classNames } from "@plasmicapp/react-web";

export type Icon9IconProps = React.ComponentProps<"svg"> & {
  title?: string;
};

export function Icon9Icon(props: Icon9IconProps) {
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
          "M6.75 19S8 15.75 12 15.75 17.25 19 17.25 19m-3-9a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-6.5 9.25h8.5a3 3 0 003-3v-8.5a3 3 0 00-3-3h-8.5a3 3 0 00-3 3v8.5a3 3 0 003 3z"
        }
      ></path>
    </svg>
  );
}

export default Icon9Icon;
/* prettier-ignore-end */
