/* eslint-disable */
/* tslint:disable */
// @ts-nocheck
/* prettier-ignore-start */
import React from "react";
import { classNames } from "@plasmicapp/react-web";

export type Icon3IconProps = React.ComponentProps<"svg"> & {
  title?: string;
};

export function Icon3Icon(props: Icon3IconProps) {
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
          "M6.75 19.25s1.575-2.5 5.25-2.5 5.25 2.5 5.25 2.5M12 4.75v.5m3.625.471l-.25.433m2.904 2.22l-.433.25M19.25 12h-.5m-.471 3.625l-.433-.25m-11.692 0l-.433.25M5.25 12h-.5m1.404-3.375l-.433-.25m2.904-2.22l-.25-.434M14.25 12a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
        }
      ></path>
    </svg>
  );
}

export default Icon3Icon;
/* prettier-ignore-end */
